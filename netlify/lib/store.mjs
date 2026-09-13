// Shared helpers for Whalarium functions: GitHub-backed JSON store, Privy sessions, user records.
// Users live in data/users.json (committed via the Contents API — same pattern as tg_subs.json;
// netlify.toml skips builds for that file). Keep writes rare: sign-in, watch add/remove, hits.
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const REPO = 'beeonchain/basefish';
export const USERS_PATH = 'data/users.json';
export const SUBS_PATH = 'data/tg_subs.json';
export const TOKENS = ['BRETT', 'TOSHI', 'BASECAT', 'AERO', 'VIRTUAL']; // static fallback; prefer trackedSyms()
let _syms = null, _symsAt = 0;
export async function trackedSyms() { // live list from tokens.config.json (site-added tokens included), cached 5 min per instance
  if (_syms && Date.now() - _symsAt < 3e5) return _syms;
  try { const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/tokens.config.json?t=${Math.floor(Date.now() / 3e5)}`); if (r.ok) { const c = await r.json(); const l = (c.tokens || []).map((t) => String(t.sym).toUpperCase()); if (l.length) { _syms = l; _symsAt = Date.now(); return l; } } } catch {}
  return _syms || TOKENS;
}
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

// ---- sessions: Privy access tokens (ES256 JWT, verified against the app's JWKS) ----
// The browser signs in with Privy (email / Google / X / wallet) and sends privy.getAccessToken() as Bearer.
// Users are keyed by their Privy DID. Linked accounts (wallets, email, X) are synced from Privy's API on demand.
export const PRIVY_APP_ID = process.env.PRIVY_APP_ID || 'cmtznydhb01760cl6wiylerak';
let _jwks = null;
const jwks = () => _jwks || (_jwks = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${PRIVY_APP_ID}/jwks.json`)));
export async function readSession(req) {
  const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!t || t.split('.').length !== 3) return null;
  try { const { payload } = await jwtVerify(t, jwks(), { issuer: 'privy.io', audience: PRIVY_APP_ID }); return payload.sub || null; } catch { return null; }
}
// linked accounts from Privy (needs PRIVY_APP_SECRET in Netlify env). Cached ~2 min per instance.
const _pu = new Map();
export async function privyUser(did, { fresh = false } = {}) {
  const sec = process.env.PRIVY_APP_SECRET; if (!sec) return null;
  const c = _pu.get(did); if (c && !fresh && Date.now() - c.at < 120e3) return c.v;
  try {
    const r = await fetch(`https://auth.privy.io/api/v1/users/${encodeURIComponent(did)}`, { headers: { Authorization: 'Basic ' + Buffer.from(`${PRIVY_APP_ID}:${sec}`).toString('base64'), 'privy-app-id': PRIVY_APP_ID } });
    if (!r.ok) return c ? c.v : null;
    const j = await r.json();
    const la = j.linked_accounts || [];
    const v = {
      wallets: la.filter((a) => a.type === 'wallet' && a.chain_type !== 'solana').map((a) => String(a.address).toLowerCase()),
      email: (la.find((a) => a.type === 'email') || {}).address || (la.find((a) => a.type === 'google_oauth') || {}).email || null,
      google: (la.find((a) => a.type === 'google_oauth') || {}).email || null,
      x: (la.find((a) => a.type === 'twitter_oauth') || {}).username || null,
      xName: (la.find((a) => a.type === 'twitter_oauth') || {}).name || null,
      created: j.created_at || null,
    };
    _pu.set(did, { at: Date.now(), v });
    return v;
  } catch { return c ? c.v : null; }
}
// admin = DIDs / emails / wallets listed in ADMIN_IDS (comma-separated) in Netlify env
// founder wallet is always admin; ADMIN_IDS (comma-separated DIDs / emails / wallets) adds more
export const FOUNDER_WALLETS = ['0xc034e02dc51eb30c9ae48069ce09bda36e4ed1ea'];
export function isAdmin(did, u) {
  const ids = [...FOUNDER_WALLETS, ...(process.env.ADMIN_IDS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)];
  const mine = [did, u && u.email, ...((u && u.wallets) || [])].filter(Boolean).map((s) => String(s).toLowerCase());
  return mine.some((m) => ids.includes(m));
}
export const PLANS = { free: { fetches: 5, watches: 10 }, pro: { fetches: 100, watches: 50 } };
export const planOf = (u) => PLANS[(u && u.plan) || 'free'] || PLANS.free;
export const fetchLimit = (u) => (u && u.fetchLimit != null ? u.fetchLimit : planOf(u).fetches);

// ---- user records ----
// users.json = { users: { did: { label, email, wallets:[], x, plan, fetchLimit?, fetches, watches:[{w,t}], hits:[...], claims:{addr:{name,avatar}}, avatar, tg?, link?, created, seen } } }
export function publicUser(u, uid, extra = {}) {
  return { id: uid, label: u.label, email: u.email || null, wallets: u.wallets || [], x: u.x || null, plan: u.plan || 'free', fetches: { used: u.fetches || 0, limit: fetchLimit(u) },
    watches: u.watches || [], tokens: u.tokens || [], hits: (u.hits || []).slice(0, MAX_HITS), tg: !!u.tg, link: u.link && u.link.exp > Date.now() ? u.link.code : null,
    claims: u.claims || {}, avatar: u.avatar || null, created: u.created || null, ...extra };
}
export const labelFor = (u) => (u.x ? '@' + u.x : u.email ? u.email.replace(/^(..).*@/, '$1…@') : (u.wallets && u.wallets[0]) ? u.wallets[0].slice(0, 6) + '…' + u.wallets[0].slice(-4) : 'whale');
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
