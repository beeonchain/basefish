// POST /api/waitlist  { email, wallet, ref? }  → { ok, position } | { ok:false, error }
// Public, unauthenticated: the landing page posts here. Rate-limited per IP hash, deduped on email and wallet.
import { db, json, isAddress, isEmail, lc, ipHash } from '../lib/db.mjs';

const BAD = { email: 'That email address does not look right.', wallet: 'That is not a Base wallet address.',
  dup: 'You are already on the list.', db: 'The waitlist is temporarily unavailable — try again shortly.',
  rate: 'Too many sign-ups from this connection. Try again later.' };

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  let b = {}; try { b = await req.json(); } catch {}
  const email = String(b.email || '').trim();
  const wallet = String(b.wallet || '').trim();
  if (!isEmail(email)) return json({ ok: false, field: 'email', error: BAD.email }, 400);
  if (!isAddress(wallet)) return json({ ok: false, field: 'wallet', error: BAD.wallet }, 400);

  const sql = db();
  if (!sql) return json({ ok: false, error: BAD.db }, 503);

  try {
    const iph = await ipHash(req);
    if (iph) {
      const [{ n }] = await sql`select count(*)::int n from waitlist where ip_hash = ${iph} and created_at > now() - interval '1 hour'`;
      if (n >= 5) return json({ ok: false, error: BAD.rate }, 429);
    }
    const rows = await sql`
      insert into waitlist (email, wallet, source, ref, ip_hash)
      values (${email}, ${lc(wallet)}, ${String(b.source || 'landing').slice(0, 24)}, ${String(b.ref || '').slice(0, 200) || null}, ${iph})
      on conflict do nothing
      returning id`;
    if (!rows.length) return json({ ok: true, already: true, message: BAD.dup });
    const [{ n }] = await sql`select count(*)::int n from waitlist where id <= ${rows[0].id}`;
    return json({ ok: true, position: n });
  } catch (e) {
    console.log('waitlist error', e.message);
    return json({ ok: false, error: BAD.db }, 500);
  }
};
function cors() { return { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST,OPTIONS' }; }
export const config = { path: '/api/waitlist' };
