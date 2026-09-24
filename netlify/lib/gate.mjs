// Private-beta access check, shared by /api/gate and every function that spends money or writes data.
// A signed-in user is let in if they are an admin, or if any wallet linked to their Privy account is on the whitelist.
import { privyUser, isAdminFull, readRaw, USERS_PATH } from './store.mjs';
import { db, lc } from './db.mjs';

export const GATE_OPEN = () => process.env.GATE_OPEN === '1';   // kill-switch: GATE_OPEN=1 lets everyone in

export async function walletsOf(uid) {
  const la = await privyUser(uid, { fresh: true }).catch(() => null);
  const ws = (la && la.wallets) || [];
  return [...new Set(ws.map(lc).filter((w) => /^0x[0-9a-f]{40}$/.test(w)))];
}

// → { allowed, reason: 'open'|'admin'|'whitelist'|'no-wallet'|'not-whitelisted'|'no-db', wallets }
export async function gateStatus(uid) {
  if (GATE_OPEN()) return { allowed: true, reason: 'open', wallets: [] };
  const wallets = await walletsOf(uid);
  const d = await readRaw(USERS_PATH, { users: {} }).catch(() => ({ users: {} }));
  const u = (d.users && d.users[uid]) || { wallets };
  if (await isAdminFull(uid, { ...u, wallets: [...new Set([...(u.wallets || []), ...wallets])] }).catch(() => false))
    return { allowed: true, reason: 'admin', wallets };
  if (!wallets.length) return { allowed: false, reason: 'no-wallet', wallets };
  const sql = db();
  if (!sql) return { allowed: false, reason: 'no-db', wallets };      // fail closed
  const rows = await sql`select wallet from whitelist where wallet = any(${wallets})`;
  return { allowed: rows.length > 0, reason: rows.length ? 'whitelist' : 'not-whitelisted', wallets };
}

export const GATE_DENIED = 'REEF is in private beta — enter an access code to use this.';
