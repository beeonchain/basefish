// POST /api/track {ca}  (signed-in users) — promote an untracked token into tokens.config.json and dispatch a refresh.
// Limits: 3 per account per day, 12 per day overall, 60 tracked tokens max (until the tiered pipeline lands).
import { readSession, updateJson, readRaw, USERS_PATH, json } from '../lib/store.mjs';

const CFG = 'tokens.config.json';
const LIMITS = { perUserDay: 3, globalDay: 12, maxTokens: 60 };
const PALETTE = ['#4C8DFF', '#F2C14E', '#A78BFA', '#22C55E', '#F97316', '#EC4899', '#14B8A6', '#EAB308', '#8B5CF6', '#EF4444', '#06B6D4', '#84CC16', '#F43F5E', '#6366F1', '#10B981', '#D946EF'];

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const uid = readSession(req);
  if (!uid) return json({ error: 'sign in to add tokens' }, 401);
  const body = await req.json().catch(() => ({}));
  const ca = String(body.ca || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ca)) return json({ error: 'bad contract address' }, 400);
  // token facts from our own lookup endpoint (cached at the CDN)
  const origin = new URL(req.url).origin;
  const info = await fetch(`${origin}/api/token?ca=${ca}`).then((r) => r.json()).catch(() => null);
  if (!info) return json({ error: 'lookup failed' }, 502);
  if (info.tracked) return json({ ok: true, already: true, sym: info.sym });
  if (!info.isToken) return json({ error: 'that address is not an ERC-20 token' }, 400);
  if (!(info.holders || []).length) return json({ error: 'no holder data available for this token yet' }, 400);
  // per-user + global daily limits (stored on the users file)
  const day = new Date().toISOString().slice(0, 10);
  let err = null;
  try {
    await updateJson(USERS_PATH, { users: {} }, (d) => {
      const u = d.users && d.users[uid]; if (!u) { err = 'no account'; return false; }
      d.meta = d.meta || {}; const g = d.meta.trackDay === day ? (d.meta.trackCount || 0) : 0;
      const mine = u.trackDay === day ? (u.trackCount || 0) : 0;
      if (mine >= LIMITS.perUserDay) { err = `limit: ${LIMITS.perUserDay} tokens per day per account`; return false; }
      if (g >= LIMITS.globalDay) { err = 'daily add limit reached for the whole site — try tomorrow'; return false; }
      u.trackDay = day; u.trackCount = mine + 1; d.meta.trackDay = day; d.meta.trackCount = g + 1;
    }, 'users: track token');
  } catch (e) { err = String(e.message || e).slice(0, 120); }
  if (err) return json({ error: err }, 400);
  // append to config
  let sym = String(info.sym || 'TOKEN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'TOKEN', added = null;
  try {
    await updateJson(CFG, { chain: 'base', tokens: [] }, (cfg) => {
      cfg.tokens = cfg.tokens || [];
      if (cfg.tokens.some((t) => String(t.contract).toLowerCase() === ca)) { added = cfg.tokens.find((t) => String(t.contract).toLowerCase() === ca).sym; return false; }
      if (cfg.tokens.length >= LIMITS.maxTokens) { err = 'tracked-token cap reached (60) — more room when the tiered pipeline ships'; return false; }
      while (cfg.tokens.some((t) => t.sym === sym)) sym = sym.slice(0, 8) + Math.floor(Math.random() * 90 + 10);
      const t = { sym, name: String(info.name || sym).slice(0, 40), color: PALETTE[cfg.tokens.length % PALETTE.length], contract: ca, exclude: [], addedBy: uid.split(':')[0], addedAt: new Date().toISOString() };
      if (info.cgId) t.coingecko = info.cgId;
      cfg.tokens.push(t); added = sym;
    }, `tokens: add ${sym} (${ca.slice(0, 10)}) via site`);
  } catch (e) { err = String(e.message || e).slice(0, 120); }
  if (err) return json({ error: err }, 400);
  // kick the pipeline so the full aquarium exists within ~10 minutes
  let dispatched = false;
  try {
    const r = await fetch('https://api.github.com/repos/beeonchain/basefish/actions/workflows/refresh.yml/dispatches', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GH_DISPATCH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'walletsea-track', 'X-GitHub-Api-Version': '2022-11-28' }, body: JSON.stringify({ ref: 'main' }) });
    dispatched = r.status === 204;
  } catch {}
  return json({ ok: true, sym: added, dispatched });
};
export const config = { path: '/api/track' };
