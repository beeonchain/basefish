// Schema + seed for the REEF database (Neon Postgres). Idempotent: safe to run on every push.
// Runs in GitHub Actions — the agent sandbox and the desktop VM cannot reach Neon's host.
import fs from 'node:fs';
import pg from 'pg';

const MASTER = ['0xc034e02dc51eb30c9ae48069ce09bda36e4ed1ea'];
const FOUNDER = ['0xd8ea15eca3f246c76ae10fcd07f7e71b9e6860d2'];

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = (s, p) => c.query(s, p);

await q(`create table if not exists waitlist (
  id           bigserial primary key,
  email        text not null,
  wallet       text not null,
  created_at   timestamptz not null default now(),
  source       text,                        -- 'landing' | 'app' | 'manual'
  ref          text,                        -- utm / referrer, if any
  ip_hash      text,                        -- sha256(ip + salt); never the raw address
  status       text not null default 'pending',   -- pending | invited | joined | rejected
  invited_at   timestamptz,
  note         text
)`);
await q(`create unique index if not exists waitlist_email_uq  on waitlist (lower(email))`);
await q(`create unique index if not exists waitlist_wallet_uq on waitlist (lower(wallet))`);
await q(`create index if not exists waitlist_created_idx on waitlist (created_at desc)`);
await q(`create index if not exists waitlist_status_idx  on waitlist (status)`);

await q(`create table if not exists access_codes (
  code_hash    text primary key,            -- sha256 of the code; the code itself is never stored
  batch        text not null default 'beta-1',
  created_at   timestamptz not null default now(),
  redeemed_by  text,                        -- wallet that used it
  redeemed_uid text,                        -- Privy DID, when signed in
  redeemed_at  timestamptz,
  revoked      boolean not null default false,
  note         text
)`);
await q(`create index if not exists access_codes_open_idx on access_codes (batch) where redeemed_at is null and not revoked`);

await q(`create table if not exists whitelist (
  wallet     text primary key,              -- always lowercase
  added_at   timestamptz not null default now(),
  source     text not null,                 -- 'admin' | 'code' | 'manual' | 'waitlist'
  added_by   text,
  note       text
)`);

// admins are always in
for (const w of [...MASTER, ...FOUNDER]) {
  await q(`insert into whitelist (wallet, source, added_by, note) values ($1, 'admin', 'system', $2)
           on conflict (wallet) do nothing`, [w.toLowerCase(), MASTER.includes(w) ? 'master admin' : 'founder']);
}
// plus anything in ADMIN_IDS that looks like an address
for (const id of (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s))) {
  await q(`insert into whitelist (wallet, source, added_by, note) values ($1, 'admin', 'system', 'ADMIN_IDS')
           on conflict (wallet) do nothing`, [id]);
}

// manual adds: wallets passed to the workflow run (input add_wallets), never committed to the public repo
const manual = (process.env.ADD_WALLETS || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s));
let manualAdded = 0;
for (const w of manual) {
  const r = await q(`insert into whitelist (wallet, source, added_by, note) values ($1, 'manual', 'bee', 'added by Bee')
           on conflict (wallet) do nothing`, [w]);
  manualAdded += r.rowCount || 0;
}
const manualPresent = manual.length ? (await q(`select count(*)::int n from whitelist where wallet = any($1)`, [manual])).rows[0].n : 0;

// access codes: seed from the committed hash file (the plaintext codes live only with Bee)
const seed = JSON.parse(fs.readFileSync('data/access_code_hashes.json', 'utf8'));
for (const h of seed.hashes) {
  await q(`insert into access_codes (code_hash, batch) values ($1, $2) on conflict (code_hash) do nothing`, [h, seed.batch]);
}

await q(`create table if not exists gate_attempts (
  id      bigserial primary key,
  ip_hash text,
  uid     text,
  at      timestamptz not null default now()
)`);
await q(`create index if not exists gate_attempts_recent_idx on gate_attempts (ip_hash, at desc)`);
await q(`delete from gate_attempts where at < now() - interval '2 days'`);

await q(`drop table if exists _infra_check`);

const stat = async (s) => (await q(s)).rows[0];
const out = {
  at: new Date().toISOString(),
  whitelist: await stat(`select count(*)::int n from whitelist`),
  manual: { asked: manual.length, added: manualAdded, present: manualPresent },
  codes: await stat(`select count(*)::int total, count(redeemed_at)::int redeemed from access_codes`),
  waitlist: await stat(`select count(*)::int n from waitlist`),
  tables: (await q(`select table_name from information_schema.tables where table_schema='public' order by 1`)).rows.map((r) => r.table_name),
};
fs.writeFileSync('data/db_status.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await c.end();
