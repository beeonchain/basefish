// Private-beta gate.
//   GET  /api/gate            → { allowed, reason, wallets }
//   POST /api/gate { code }   → redeem an access code; whitelists the signed-in user's wallet
// A wallet gets in three ways: it is an admin, it is already on the whitelist, or it redeems a code.
import { readSession, privyUser, isAdminFull, readRaw, USERS_PATH } from '../lib/store.mjs';
import { db, json, lc, sha256, ipHash } from '../lib/db.mjs';

const OPEN = process.env.GATE_OPEN === '1';          // kill-switch: set GATE_OPEN=1 to let everyone in

async function walletsOf(uid) {
  const la = await privyUser(uid, { fresh: true }).catch(() => null);
  const ws = (la && la.wallets) || [];
  return [...new Set(ws.map(lc).filter((w) => /^0x[0-9a-f]{40}$/.test(w)))];
}
async function status(uid) {
  if (OPEN) return { allowed: true, reason: 'open', wallets: [] };
  const d = await readRaw(USERS_PATH, { users: {} }).catch(() => ({ users: {} }));
  const u = d.users && d.users[uid];
  if (await isAdminFull(uid, u).catch(() => false)) return { allowed: true, reason: 'admin', wallets: await walletsOf(uid) };
  const wallets = await walletsOf(uid);
  const sql = db();
  if (!sql) return { allowed: false, reason: 'no-db', wallets };
  if (!wallets.length) return { allowed: false, reason: 'no-wallet', wallets };
  const rows = await sql`select wallet from whitelist where wallet = any(${wallets})`;
  return { allowed: rows.length > 0, reason: rows.length ? 'whitelist' : 'not-whitelisted', wallets };
}

export default async (req) => {
  const uid = await readSession(req);
  if (!uid) return json({ allowed: false, reason: 'signed-out' }, 401);

  if (req.method === 'GET') return json(await status(uid));
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
