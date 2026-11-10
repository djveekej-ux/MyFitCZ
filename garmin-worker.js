// MyFitCZ – prostředník pro Garmin Personal API (Cloudflare Worker)
// Jen přeposílá vybrané dotazy z tvé stránky na Garmin a přidá CORS hlavičky.
// Garmin klíč ani data nikam neukládá. Navíc drží denní zálohu aplikace v KV (BACKUP),
// uloženou pod hashem náhodného kódu zálohy, který zná jen telefon jezdce.

// Adresy, ze kterých běží MyFitCZ (bez lomítka na konci): GitHub Pages a Cloudflare Pages.
const ALLOW_ORIGINS = ['https://djveekej-ux.github.io', 'https://myfitcz.pages.dev'];

const UPSTREAM = 'https://personal.connectapi.garmin.com';

// Povolené cesty – nic jiného prostředník nepustí.
const PATHS = [
  /^\/personalapitoken-service\/personal-api\/personal-api-key\/token$/,
  /^\/sleep-service\/sleep\/dailySleep$/,
  /^\/hrv-service\/hrv\/\d{4}-\d{2}-\d{2}$/,
  /^\/wellness-service\/wellness\/bodyBattery\/reports\/daily$/,
  /^\/wellness-service\/wellness\/daily\/spo2\/\d{4}-\d{2}-\d{2}$/,
  /^\/usersummary-service\/v2\/dailysummaries$/,
  /^\/usersummary-service\/usersummary\/daily$/,
  /^\/fitnessage-service\/fitnessage\/v2\/\d{4}-\d{2}-\d{2}$/,
  // VO2max (obecné i cyklistické) za rozsah dnů.
  /^\/metrics-service\/metrics\/maxmet\/daily\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/,
  // Zkušebně – Garmin je v Personal API možná nevydá (pak vrátí 404 a aplikace je přeskočí).
  /^\/metrics-service\/metrics\/trainingreadiness\/\d{4}-\d{2}-\d{2}$/,
  /^\/metrics-service\/metrics\/trainingstatus\/aggregated\/\d{4}-\d{2}-\d{2}$/,
];

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = ALLOW_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOW_ORIGINS[0],
      'Access-Control-Allow-Headers': 'Authorization, Accept, Content-Type, X-Backup-Key',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (!allowed) {
      return new Response('Forbidden', { status: 403, headers: cors });
    }

    const url = new URL(req.url);
    if (url.pathname === '/backup') return backup(req, env, cors);
    if (!PATHS.some((r) => r.test(url.pathname))) {
      return new Response('Not allowed', { status: 404, headers: cors });
    }
    // Klíč se vyměňuje za token metodou POST, všechno ostatní se jen čte (GET).
    const isToken = PATHS[0].test(url.pathname);
    if (req.method !== (isToken ? 'POST' : 'GET')) {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }
    if (!(req.headers.get('Authorization') || '').trim()) {
      return new Response('Unauthorized', { status: 401, headers: cors });
    }

    const headers = new Headers();
    const auth = req.headers.get('Authorization');
    if (auth) headers.set('Authorization', auth);
    headers.set('Accept', req.headers.get('Accept') || '*/*');

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + url.pathname + url.search, { method: req.method, headers });
    } catch (e) {
      return new Response('Garmin unreachable', { status: 502, headers: cors });
    }

    const out = new Headers(cors);
    const ct = upstream.headers.get('Content-Type');
    if (ct) out.set('Content-Type', ct);
    out.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};

// Záloha dat aplikace. Kód zálohy (32–64 hex znaků) posílá telefon v hlavičce X-Backup-Key,
// do KV se ukládá jen jeho SHA-256 hash. Drží se aktuální a jedna předchozí verze.
async function backup(req, env, cors) {
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (!env || !env.BACKUP) return json({ error: 'kv-missing' }, 503);
  const code = (req.headers.get('X-Backup-Key') || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32,64}$/.test(code)) return json({ error: 'bad-key' }, 401);
  const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  const id = [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (req.method === 'GET') {
    const v = await env.BACKUP.get('b:' + id);
    if (!v) return json({ error: 'not-found' }, 404);
    return new Response(v, { status: 200, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  if (req.method === 'PUT') {
    const body = await req.text();
    if (body.length > 4000000) return json({ error: 'too-large' }, 413);
    try { const o = JSON.parse(body); if (!o || typeof o.data !== 'object') throw 0; } catch (e) { return json({ error: 'bad-json' }, 400); }
    const prev = await env.BACKUP.get('b:' + id);
    if (prev) await env.BACKUP.put('p:' + id, prev);
    await env.BACKUP.put('b:' + id, body);
    return json({ ok: true, at: new Date().toISOString() });
  }
  return json({ error: 'method' }, 405);
}
