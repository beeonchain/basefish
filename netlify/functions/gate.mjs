// Private-beta gate.
//   GET  /api/gate            → { allowed, reason, wallets }
//   POST /api/gate { code }   → redeem an access code; whitelists the signed-in user's wallet
// A wallet gets in three ways: it is an admin, it is already on the whitelist, or it redeems a code.
import { readSession } from '../lib/store.mjs';
import { db, json, sha256, ipHash } from '../lib/db.mjs';
import { gateStatus, walletsOf } from '../lib/gate.mjs';

export default async (req) => {
  const uid = await readSession(req);
  if (!uid) return json({ allowed: false, reason: 'signed-out' }, 401);

  if (req.method === 'GET') return json(await gateStatus(uid));
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  const b = await req.json().catch(() => ({}));
  const code = String(b.code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^REEF(-[0-9A-Z]{4}){4}$/.test(code)) return json({ ok: false, error: 'That code is not in the right format.' }, 400);

  const sql = db();
  if (!sql) return json({ ok: false, error: 'Access codes are temporarily unavailable.' }, 503);

  const wallets = await walletsOf(uid);
  if (!wallets.length) return json({ ok: false, error: 'Connect a wallet first — the code is tied to the wallet that redeems it.' }, 400);

  // brute force is pointless against 100-bit codes, but a wrong-guess limit keeps the logs clean
  const iph = await ipHash(req);
  if (iph) {
    const [{ n }] = await sql`select count(*)::int n from gate_attempts where ip_hash = ${iph} and at > now() - interval '15 minutes'`;
    if (n >= 10) return json({ ok: false, error: 'Too many attempts. Wait fifteen minutes.' }, 429);
    await sql`insert into gate_attempts (ip_hash, uid) values (${iph}, ${uid})`;
  }

  const hash = await sha256(code);
  const rows = await sql`
    update access_codes set redeemed_by = ${wallets[0]}, redeemed_uid = ${uid}, redeemed_at = now()
    where code_hash = ${hash} and redeemed_at is null and not revoked
    returning batch`;
  if (!rows.length) {
    const [ex] = await sql`select redeemed_at, revoked from access_codes where code_hash = ${hash}`;
    if (!ex) return json({ ok: false, error: 'That code is not valid.' }, 400);
    if (ex.revoked) return json({ ok: false, error: 'That code has been revoked.' }, 400);
    return json({ ok: false, error: 'That code has already been used.' }, 400);
  }
  await sql`insert into whitelist (wallet, source, added_by, note)
            values (${wallets[0]}, 'code', ${uid}, ${'batch ' + rows[0].batch})
            on conflict (wallet) do nothing`;
  await sql`update waitlist set status = 'joined' where lower(wallet) = ${wallets[0]}`;
  return json({ ok: true, wallet: wallets[0] });
};
export const config = { path: '/api/gate' };
