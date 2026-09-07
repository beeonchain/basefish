// Shared helpers for Basefish functions: GitHub-backed JSON store, sessions (JWT), user records.
// Users live in data/users.json (committed via the Contents API — same pattern as tg_subs.json;
// netlify.toml skips builds for that file). Keep writes rare: sign-in, watch add/remove, hits.
import crypto from 'node:crypto';

export const REPO = 'beeonchain/basefish';
export const USERS_PATH = 'data/users.json';
export const SUBS_PATH = 'data/tg_subs.json';
export const TOKENS = ['BRETT', 'TOSHI', 'BASECAT', 'AERO', 'VIRTUAL'];
export const MAX_WATCHES = 10;
export const MAX_HITS = 40;

const gh = (t) => ({ Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json', 'User-Agent': 'basefish-fn', 'X-GitHub-Api-Version': '2022-11-28' });
const ghToken = () => process.env.GH_DISPATCH_TOKEN;

export async function readJson(path, fallback) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=main`, { headers: gh(ghToken()) });
  if (r.status === 404) return { data: fallback, sha: null };
  if (!r.ok) throw new Error('github read ' + r.status);
  const d = await r.json();
  return { data: JSON.parse(Buffer.from(d.content, 'base64').toString('utf8')), sha: d.sha };
}
// read → mutate → write with sha; retries on conflict (other functions write the same file)
export async function updateJson(path, fallback, mutate, message) {
  let last = null;
  for (let i = 0; i < 4; i++) {
    const { data, sha } = await readJson(path, fallback);
    const res = mutate(data); // return false to skip the write
    if (res === false) return data;
    const body = { message: message || `store: ${path}`, content: Buffer.from(JSON.stringify(data)).toString('base64'), branch: 'main' };
    if (sha) body.sha = sha;
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, { method: 'PUT', headers: gh(ghToken()), body: JSON.stringify(body) });
    if (r.ok) return data;
    last = r.status;
    await new Promise((s) => setTimeout(s, 300 + Math.random() * 500));
  }
  throw new Error('github write failed ' + last);
}
// fast read for hot paths (raw CDN, no API quota); falls back to the API
export async function readRaw(path, fallback) {
  try { const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`); if (r.ok) return await r.json(); } catch {}
  try { return (await readJson(path, fallback)).data; } catch { return fallback; }
}

// ---- sessions: HS256 JWT, 30 days ----
const secret = () => process.env.AUTH_SECRET || crypto.createHash('sha256').update('basefish-auth:' + (process.env.GH_DISPATCH_TOKEN || '')).digest('hex');
const b64u = (b) => Buffer.from(b).toString('base64url');
export function signSession(uid) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify({ sub: uid, iat: Math.floor(Date.now() / 1e3), exp: Math.floor(Date.now() / 1e3) + 30 * 86400 }));
  return `${h}.${p}.${crypto.createHmac('sha256', secret()).update(`${h}.${p}`).digest('base64url')}`;
}
export function readSession(req) {
  const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [h, p, s] = t.split('.'); if (!h || !p || !s) return null;
  const want = crypto.createHmac('sha256', secret()).update(`${h}.${p}`).digest('base64url');
  if (want.length !== s.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(s))) return null;
  try { const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return c.exp > Date.now() / 1e3 ? c.sub : null; } catch { return null; }
}
// short-lived nonce for wallet sign-in: HMAC of address + 5-minute bucket (stateless)
export function nonceFor(addr, bucketOffset = 0) {
  const b = Math.floor(Date.now() / 3e5) + bucketOffset;
  return crypto.createHmac('sha256', secret()).update(`nonce:${addr.toLowerCase()}:${b}`).digest('hex').slice(0, 16);
}
export const siweMessage = (addr, nonce) => `Sign in to Basefish\n\nWallet: ${addr}\nNonce: ${nonce}\n\nThis signature costs no gas and only proves you own this wallet.`;

// ---- user records ----
// users.json = { users: { uid: { label, kind:'wallet'|'google', addr?, email?, watches:[{w,t}], hits:[...], tg?: chatId, link?: {code,exp}, created, seen } } }
export const uidFor = (kind, id) => `${kind}:${id.toLowerCase()}`;
export function publicUser(u, uid) {
  return { id: uid, kind: u.kind, label: u.label, watches: u.watches || [], hits: (u.hits || []).slice(0, MAX_HITS), tg: !!u.tg, link: u.link && u.link.exp > Date.now() ? u.link.code : null };
}
export const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// keep the Alchemy Address Activity webhook in sync with watched wallets (needs ALCH_NOTIFY_TOKEN — the
// Notify auth token from the Alchemy dashboard, not the app API key). Best-effort, silent on failure.
export async function webhookAddresses(add = [], remove = []) {
  const tok = process.env.ALCH_NOTIFY_TOKEN, id = process.env.ALCH_WEBHOOK_ID || 'wh_1ailuvfsjb3deig0';
  if (!tok || (!add.length && !remove.length)) return false;
  try {
    const r = await fetch('https://dashboard.alchemy.com/api/update-webhook-addresses', {
      method: 'PATCH', headers: { 'X-Alchemy-Token': tok, 'content-type': 'application/json' },
      body: JSON.stringify({ webhook_id: id, addresses_to_add: add, addresses_to_remove: remove }),
    });
    return r.ok;
  } catch { return false; }
}
