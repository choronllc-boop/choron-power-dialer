// node server.mjs   ->  http://localhost:8000
// Serves the page with zero dependencies. The /token and /voice routes only wake up
// if you set the Twilio env vars; without them this is just a static file server.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const PORT = process.env.PORT || 8000;
const ROOT = import.meta.dirname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
                '.css': 'text/css', '.csv': 'text/csv', '.ico': 'image/x-icon' };

const TWILIO = ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY', 'TWILIO_API_SECRET', 'TWILIO_TWIML_APP_SID', 'TWILIO_CALLER_ID'];
const twilioReady = TWILIO.every(k => process.env[k]);

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Twilio needs /voice reachable through a tunnel. Nothing else should be: the folder holds
  // your lead CSVs, and /token mints a credential that can place calls on your account.
  if (!LOCAL.test(req.headers.host || '')) {
    if (url.pathname !== '/voice') { res.writeHead(404).end('not found'); return; }
    return voice(req, res, url);
  }

  if (url.pathname === '/token') return token(res);
  if (url.pathname === '/voice') return voice(req, res, url);
  if (url.pathname === '/reviews') return reviews(res, url.searchParams.get('q'));

  try {
    // normalize first so ../.. can't escape the folder; decode is inside the try because a
    // malformed escape like /% throws, and an unhandled rejection here kills the server
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\.])+/, '');
    const file = join(ROOT, rel || 'index.html');
    if (!file.startsWith(ROOT + sep)) { res.writeHead(403).end('forbidden'); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`power dialer -> http://localhost:${PORT}`);
  console.log(twilioReady
    ? 'Twilio: configured, in-browser calling enabled'
    : `Twilio: off (set ${TWILIO.join(', ')} to enable). Google Voice and tel: modes work regardless.`);
});

// Google reviews. The map iframe is cross-origin, so nothing can be read out of it, and
// scraping maps.google.com is against Google's terms - Places API is the supported path.
// Returns at most 5 reviews; that is all the API gives, there is no page 2.
const revCache = new Map();   // one billed call per business per server run

async function reviews(res, q) {
  const json = (code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return json(200, { error: 'set GOOGLE_MAPS_API_KEY to load reviews — see README' });
  if (!q || !q.trim()) return json(200, { error: 'no name or address in this row to search on' });
  if (revCache.has(q)) return json(200, revCache.get(q));

  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName,places.rating,places.userRatingCount,places.reviews' },
      body: JSON.stringify({ textQuery: q, maxResultCount: 1 }),
    });
    const body = await r.json();
    if (!r.ok) return json(200, { error: 'Places API: ' + (body.error?.message || r.status) });

    const p = body.places?.[0];
    if (!p) return json(200, { error: 'no Google listing matched that name and address' });
    const out = {
      name: p.displayName?.text || '', rating: p.rating, total: p.userRatingCount,
      reviews: (p.reviews || []).map(v => ({
        author: v.authorAttribution?.displayName || 'anonymous',
        rating: v.rating,
        when: v.relativePublishTimeDescription || '',
        text: v.text?.text || v.originalText?.text || '',
      })),
    };
    revCache.set(q, out);
    json(200, out);
  } catch (e) {
    json(200, { error: 'reviews lookup failed: ' + e.message });
  }
}

async function token(res) {
  if (!twilioReady) { res.writeHead(501).end('Twilio env vars not set'); return; }
  const { default: twilio } = await import('twilio'); // only needed in Twilio mode
  const { AccessToken } = twilio.jwt;
  const t = new AccessToken(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_API_KEY,
                            process.env.TWILIO_API_SECRET, { identity: 'dialer', ttl: 600 });
  t.addGrant(new AccessToken.VoiceGrant({
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
    incomingAllow: false,
  }));
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: t.toJwt() }));
}

// Twilio hits this to find out what to do with the call. Point your TwiML App's
// Voice URL at <your public tunnel>/voice.
function voice(req, res, url) {
  if (!twilioReady) { res.writeHead(501).end('Twilio env vars not set'); return; }
  const send = to => {
    const num = String(to || '').replace(/[^\d+]/g, '');
    res.writeHead(200, { 'content-type': 'text/xml' }).end(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${process.env.TWILIO_CALLER_ID}"><Number>${num}</Number></Dial></Response>`);
  };
  if (req.method !== 'POST') return send(url.searchParams.get('To'));
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', () => send(new URLSearchParams(body).get('To')));
}
