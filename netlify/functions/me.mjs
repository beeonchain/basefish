// Account endpoint (Privy-authenticated). GET → profile (creates the record on first visit, syncs linked accounts).
// POST {op:'add', w, t} | {op:'remove', w, t} | {op:'linkcode'} | {op:'unlink'} | {op:'clearhits'} | {op:'sync'}
//      | {op:'claim', addr, name?} | {op:'unclaim', addr} | {op:'avatar', avatar:{fish,color,acc}}
import { readRaw, updateJson, USERS_PATH, SUBS_PATH, readSession, privyUser, publicUser, labelFor, json, trackedSyms, planOf, webhookAddresses, isAdmin } from '../lib/store.mjs';

const AVATAR = { fish: ['small', 'medium', 'large', 'whale'], color: ['blue', 'gold', 'coral'], acc: ['none', 'crown', 'chain'] };
// v2 = the layered shark PFP (assets/avatar.js): one id per trait category, validated against the collection
const SHARK = {
  bg: ['deep', 'reef', 'base', 'mint', 'sand', 'sunset', 'lilac', 'ink', 'coral', 'abyss', 'aurora'],
  skin: ['steel', 'blue', 'navy', 'teal', 'sand', 'coral', 'lavender', 'olive', 'rose', 'onyx', 'zombie', 'gold', 'emerald'],
  clothes: ['none', 'tee', 'teeblue', 'hoodie', 'tank', 'suit', 'tracksuit', 'hawaiian', 'turtle', 'labcoat', 'bomber', 'tux'],
  chain: ['none', 'gold', 'silver', 'choker', 'diamond'], eyes: ['none', 'shades', 'monocle'],
  hat: ['none', 'cap', 'beanie', 'cowboy', 'hockey', 'army', 'crown', 'halo'],
};
function applyLinked(u, la) { if (!la) return; u.wallets = la.wallets; u.email = la.email; u.x = la.x; u.label = labelFor(u); }

export default async (req) => {
  const uid = await readSession(req);
  if (!uid) return json({ error: 'sign in' }, 401);
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const d = await readRaw(USERS_PATH, { users: {} });
    let u = d.users && d.users[uid];
    if (!u || url.searchParams.get('sync')) { // first visit: create the record with the accounts Privy knows about
      const la = await privyUser(uid, { fresh: true });
      await updateJson(USERS_PATH, { users: {} }, (dd) => { dd.users = dd.users || {}; const x = dd.users[uid] || (dd.users[uid] = { watches: [], hits: [], fetches: 0, plan: 'free', created: Date.now() }); applyLinked(x, la); x.seen = Date.now(); u = x; }, 'users: sign-in');
    }
    return json({ user: publicUser(u, uid, { admin: isAdmin(uid, u) }) });
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const body = await req.json().catch(() => ({}));
  const op = String(body.op || '');
  const TOKENS = await trackedSyms();
  const la = op === 'sync' || op === 'claim' ? await privyUser(uid, { fresh: true }) : null;
  let out = null, err = null, addedAddr = null;
  try {
    await updateJson(USERS_PATH, { users: {} }, (d) => {
      const u = d.users && d.users[uid];
      if (!u) { err = 'no account'; return false; }
      u.watches = u.watches || []; u.hits = u.hits || [];
      if (la) applyLinked(u, la);
      if (op === 'add') {
        const w = String(body.w || '').toLowerCase(), t = String(body.t || '').toUpperCase();
        if (!/^0x[0-9a-f]{40}$/.test(w)) { err = 'that is not a wallet address'; return false; }
        if (!TOKENS.includes(t)) { err = 'unknown token'; return false; }
        if (u.watches.some((x) => x.w === w && x.t === t)) { err = 'already watching'; return false; }
        if (u.watches.length >= planOf(u).watches) { err = `your plan allows ${planOf(u).watches} watches`; return false; }
        u.watches.push({ w, t, added: Date.now() }); addedAddr = w;
      } else if (op === 'remove') {
        const w = String(body.w || '').toLowerCase(), t = String(body.t || '').toUpperCase();
        const n = u.watches.length; u.watches = u.watches.filter((x) => !(x.w === w && (!t || x.t === t)));
        if (u.watches.length === n) { err = 'not on your list'; return false; }
      } else if (op === 'watchtok' || op === 'unwatchtok') {
        const t = String(body.t || '').toUpperCase(); if (!TOKENS.includes(t)) { err = 'unknown token'; return false; }
        u.tokens = u.tokens || [];
        if (op === 'watchtok') { if (u.tokens.includes(t)) { err = 'already watching'; return false; } if (u.tokens.length >= planOf(u).watches) { err = `your plan allows ${planOf(u).watches} watches`; return false; } u.tokens.push(t); }
        else u.tokens = u.tokens.filter((x) => x !== t);
      } else if (op === 'linkcode') {
        const code = Math.random().toString(36).slice(2, 8).toUpperCase();
        u.link = { code, exp: Date.now() + 15 * 60e3 };
      } else if (op === 'unlink') {
        u.tg = null; u.link = null;
      } else if (op === 'clearhits') {
        u.hits = [];
      } else if (op === 'sync') {
        // linked accounts refreshed above
      } else if (op === 'claim') {
        const a = String(body.addr || '').toLowerCase();
        if (!(u.wallets || []).includes(a)) { err = 'link that wallet to your account first (Account → verify another wallet)'; return false; }
        u.claims = u.claims || {}; u.claims[a] = { name: String(body.name || '').slice(0, 24) || null, ts: Date.now() };
      } else if (op === 'unclaim') {
        const a = String(body.addr || '').toLowerCase(); if (u.claims) delete u.claims[a];
      } else if (op === 'avatar') {
        const v = body.avatar || {};
        if (v.v === 2) { const a = { v: 2 }; for (const k of Object.keys(SHARK)) a[k] = SHARK[k].includes(v[k]) ? v[k] : SHARK[k][0]; u.avatar = a; }
        else { const pick = (k, dflt) => (AVATAR[k].includes(v[k]) ? v[k] : dflt); u.avatar = { fish: pick('fish', 'medium'), color: pick('color', 'blue'), acc: pick('acc', 'none') }; }
      } else { err = 'unknown op'; return false; }
      u.seen = Date.now();
      out = publicUser(u, uid, { admin: isAdmin(uid, u) });
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
