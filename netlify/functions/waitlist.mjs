// POST /api/waitlist  { email, wallet, ref? }  → { ok, position } | { ok:false, error }
// Public, unauthenticated: the landing page posts here. Rate-limited per IP hash, deduped on email and wallet.
import { db, isAddress, isEmail, lc, ipHash } from '../lib/db.mjs';

// The landing page lives on usereef.io and this function on app.usereef.io, so every reply needs CORS —
// not just the preflight. Locked to our own origins rather than '*'.
const ALLOW = ['https://usereef.io', 'https://www.usereef.io', 'http://localhost:8801'];
const cors = (req) => {
  const o = req.headers.get('origin') || '';
  return { 'access-control-allow-origin': ALLOW.includes(o) ? o : 'https://usereef.io',
           'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST,OPTIONS',
           'access-control-max-age': '86400', vary: 'origin' };
};
const json = (req, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) } });

const BAD = { email: 'That email address does not look right.', wallet: 'That is not a Base wallet address.',
  dup: 'You are already on the list.', db: 'The waitlist is temporarily unavailable — try again shortly.',
  rate: 'Too many sign-ups from this connection. Try again later.' };

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'POST only' }, 405);

  let b = {}; try { b = await req.json(); } catch {}
  const email = String(b.email || '').trim();
  const wallet = String(b.wallet || '').trim();
  if (!isEmail(email)) return json(req, { ok: false, field: 'email', error: BAD.email }, 400);
  if (!isAddress(wallet)) return json(req, { ok: false, field: 'wallet', error: BAD.wallet }, 400);

  const sql = db();
  if (!sql) return json(req, { ok: false, error: BAD.db }, 503);

  try {
    const iph = await ipHash(req);
    if (iph) {
      const [{ n }] = await sql`select count(*)::int n from waitlist where ip_hash = ${iph} and created_at > now() - interval '1 hour'`;
      if (n >= 5) return json(req, { ok: false, error: BAD.rate }, 429);
    }
    const rows = await sql`
      insert into waitlist (email, wallet, source, ref, ip_hash)
      values (${email}, ${lc(wallet)}, ${String(b.source || 'landing').slice(0, 24)}, ${String(b.ref || '').slice(0, 200) || null}, ${iph})
      on conflict do nothing
      returning id`;
    if (!rows.length) return json(req, { ok: true, already: true, message: BAD.dup });
    const [{ n }] = await sql`select count(*)::int n from waitlist where id <= ${rows[0].id}`;
    return json(req, { ok: true, position: n });
  } catch (e) {
    console.log('waitlist error', e.message);
    return json(req, { ok: false, error: BAD.db }, 500);
  }
};
export const config = { path: '/api/waitlist' };
