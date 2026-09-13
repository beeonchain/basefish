// POST /api/propose — signed-in users propose a tag or an identity for a wallet; admins approve in /admin.
// {kind:'tag', addr, tag, note?} | {kind:'identity', addr, x?, name?, evidence?}
import { readSession, updateJson, readRaw, USERS_PATH, json } from '../lib/store.mjs';
const TAGS_OK = ['CT', 'WHALE', 'SNIPE', 'DIAMOND', 'OG', 'DEV', 'MM', 'CEX', 'SCAM', 'INSIDER'];
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const uid = await readSession(req); if (!uid) return json({ error: 'sign in' }, 401);
  const b = await req.json().catch(() => ({}));
  const addr = String(b.addr || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return json({ error: 'bad address' }, 400);
  const kind = b.kind === 'identity' ? 'identity' : 'tag';
  const p = { id: Math.random().toString(36).slice(2, 10), kind, addr, uid, status: 'open', ts: Date.now() };
  if (kind === 'tag') { const tag = String(b.tag || '').toUpperCase(); if (!TAGS_OK.includes(tag)) return json({ error: 'tag must be one of ' + TAGS_OK.join(', ') }, 400); p.tag = tag; p.note = String(b.note || '').slice(0, 140); }
  else { p.x = String(b.x || '').replace(/^@/, '').slice(0, 30) || null; p.name = String(b.name || '').slice(0, 40) || null; p.evidence = String(b.evidence || '').slice(0, 200) || null; if (!p.x && !p.name) return json({ error: 'give an X handle or a name' }, 400); }
  const users = await readRaw(USERS_PATH, { users: {} }); const u = users.users && users.users[uid];
  p.by = u ? u.label : uid;
  let n = 0;
  await updateJson('data/proposals.json', { items: [] }, (d) => { d.items = d.items || []; n = d.items.filter((x) => x.uid === uid && x.status === 'open').length; if (n >= 10) throw new Error('you have 10 open proposals already'); d.items.push(p); }, `proposals: ${kind} ${addr.slice(0, 8)}`);
  return json({ ok: true, proposal: p });
};
export const config = { path: '/api/propose' };
