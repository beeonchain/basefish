// Sign in: wallet (sign a message — EOA + smart wallets via ERC-1271/6492) or Google (ID token).
// Returns a session JWT the site keeps in localStorage and sends as Authorization: Bearer.
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { updateJson, USERS_PATH, signSession, nonceFor, siweMessage, uidFor, publicUser, json } from '../lib/store.mjs';

const RPC = process.env.ALCHEMY_RPC || 'https://base-mainnet.g.alchemy.com/v2/alch_XrAYuto21vrOGXzYZX9OP';

async function upsert(uid, fields) {
  let user = null;
  await updateJson(USERS_PATH, { users: {} }, (d) => {
    d.users = d.users || {};
    const u = d.users[uid] || (d.users[uid] = { ...fields, watches: [], hits: [], created: Date.now() });
    Object.assign(u, fields, { seen: Date.now() });
    user = u;
  }, 'users: sign-in');
  return user;
}

export default async (req) => {
  const url = new URL(req.url);
  if (req.method === 'GET') return json({ google: process.env.GOOGLE_CLIENT_ID || null, wallet: true, bot: process.env.TG_BOT_HANDLE || 'aquariumtest_bot' });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const body = await req.json().catch(() => ({}));
  try {
    if (body.mode === 'nonce') {
      const addr = String(body.addr || '');
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return json({ error: 'bad address' }, 400);
      const nonce = nonceFor(addr);
      return json({ nonce, message: siweMessage(addr, nonce) });
    }
    if (body.mode === 'wallet') {
      const addr = String(body.addr || ''), sig = String(body.sig || ''), nonce = String(body.nonce || '');
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || !sig.startsWith('0x')) return json({ error: 'bad input' }, 400);
      if (nonce !== nonceFor(addr) && nonce !== nonceFor(addr, -1)) return json({ error: 'nonce expired — try again' }, 400);
      const client = createPublicClient({ chain: base, transport: http(RPC) });
      const ok = await client.verifyMessage({ address: addr, message: siweMessage(addr, nonce), signature: sig });
      if (!ok) return json({ error: 'signature did not verify' }, 401);
      const uid = uidFor('wallet', addr);
      const u = await upsert(uid, { kind: 'wallet', addr: addr.toLowerCase(), label: addr.slice(0, 6) + '…' + addr.slice(-4) });
      return json({ token: signSession(uid), user: publicUser(u, uid) });
    }
    if (body.mode === 'google') {
      const cid = process.env.GOOGLE_CLIENT_ID;
      if (!cid) return json({ error: 'Google sign-in not configured' }, 400);
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(body.credential || '')));
      const info = r.ok ? await r.json() : null;
      if (!info || info.aud !== cid || info.email_verified !== 'true' || !info.email) return json({ error: 'google token rejected' }, 401);
      const uid = uidFor('google', info.sub);
      const u = await upsert(uid, { kind: 'google', email: info.email, label: info.email.replace(/^(..).*@/, '$1…@') });
      return json({ token: signSession(uid), user: publicUser(u, uid) });
    }
    return json({ error: 'unknown mode' }, 400);
  } catch (e) { return json({ error: String(e.message || e).slice(0, 200) }, 500); }
};
export const config = { path: '/api/auth' };
