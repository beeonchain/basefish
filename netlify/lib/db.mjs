// Postgres (Neon) over HTTPS — no TCP pool to keep warm, which is what a serverless function wants.
// Every query is parameterised; nothing here ever interpolates user input into SQL.
import { neon } from '@neondatabase/serverless';

let _sql = null;
export function db() {
  if (!process.env.DATABASE_URL) return null;      // not configured yet → callers fall back to JSON
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}
export const isAddress = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s.trim());
export const lc = (s) => String(s || '').trim().toLowerCase();
// tolerant but strict enough to keep junk out; real validation is the confirmation email later
export const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s.trim()) && s.length <= 254;

export async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export async function ipHash(req) {
  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || '';
  return ip ? (await sha256(ip.split(',')[0].trim() + '|' + (process.env.PRIVY_APP_ID || 'reef'))).slice(0, 32) : null;
}
export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
