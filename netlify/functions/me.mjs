// Account endpoint. GET → profile (watches, private hits, TG link state).
// POST {op:'add', w, t} | {op:'remove', w, t} | {op:'linkcode'} | {op:'unlink'} | {op:'clearhits'}
import { readRaw, updateJson, USERS_PATH, SUBS_PATH, readSession, publicUser, json, trackedSyms, MAX_WATCHES, webhookAddresses } from '../lib/store.mjs';

export default async (req) => {
  const uid = readSession(req);
  if (!uid) return json({ error: 'sign in' }, 401);
  if (req.method === 'GET') {
    const d = await readRaw(USERS_PATH, { users: {} });
    const u = d.users && d.users[uid];
    return u ? json({ user: publicUser(u, uid) }) : json({ error: 'no account' }, 401);
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const body = await req.json().catch(() => ({}));
  const op = String(body.op || '');
  const TOKENS = await trackedSyms();
  let out = null, err = null, addedAddr = null;
  try {
    await updateJson(USERS_PATH, { users: {} }, (d) => {
      const u = d.users && d.users[uid];
      if (!u) { err = 'no account'; return false; }
      u.watches = u.watches || []; u.hits = u.hits || [];
      if (op === 'add') {
        const w = String(body.w || '').toLowerCase(), t = String(body.t || '').toUpperCase();
        if (!/^0x[0-9a-f]{40}$/.test(w)) { err = 'that is not a wallet address'; return false; }
        if (!TOKENS.includes(t)) { err = 'unknown token'; return false; }
        if (u.watches.some((x) => x.w === w && x.t === t)) { err = 'already watching'; return false; }
        if (u.watches.length >= MAX_WATCHES) { err = `limit is ${MAX_WATCHES} watches`; return false; }
        u.watches.push({ w, t, added: Date.now() }); addedAddr = w;
      } else if (op === 'remove') {
        const w = String(body.w || '').toLowerCase(), t = String(body.t || '').toUpperCase();
        const n = u.watches.length; u.watches = u.watches.filter((x) => !(x.w === w && (!t || x.t === t)));
        if (u.watches.length === n) { err = 'not on your list'; return false; }
      } else if (op === 'linkcode') {
        const code = Math.random().toString(36).slice(2, 8).toUpperCase();
        u.link = { code, exp: Date.now() + 15 * 60e3 };
      } else if (op === 'unlink') {
        u.tg = null; u.link = null;
      } else if (op === 'clearhits') {
        u.hits = [];
      } else { err = 'unknown op'; return false; }
      u.seen = Date.now();
      out = publicUser(u, uid);
    }, `users: ${op}`);
  } catch (e) { err = String(e.message || e).slice(0, 160); }
  if (err) return json({ error: err }, 400);
  if (addedAddr) await webhookAddresses([addedAddr]); // instant alerts for wallets outside the top-100
  if (op === 'unlink') { // also drop the pointer on the bot side
    try { await updateJson(SUBS_PATH, { chats: {} }, (s) => { let hit = false; for (const c of Object.values(s.chats || {})) if (c.uid === uid) { delete c.uid; hit = true; } return hit ? undefined : false; }, 'tg: unlink account'); } catch {}
  }
  return json({ user: out });
};
export const config = { path: '/api/me' };
