// End-to-end smoke test of every external service REEF depends on. Runs in GitHub Actions (the only place with
// open egress to Neon) and writes data/infra_check.json, because Actions logs are not readable from the agent side.
import fs from 'node:fs';

const out = { at: new Date().toISOString(), checks: {} };
const ok = (k, detail) => { out.checks[k] = { ok: true, ...detail }; console.log(`PASS ${k}`, JSON.stringify(detail)); };
const bad = (k, err, detail) => { out.checks[k] = { ok: false, error: String(err).slice(0, 200), ...detail }; console.log(`FAIL ${k}: ${err}`); };
const run = async (k, fn) => { try { ok(k, await fn()); } catch (e) { bad(k, e.message || e); } };

const ALCH = process.env.ALCHEMY_API_KEY;

await run('postgres', async () => {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const v = await c.query('select version() v, current_database() db');
  await c.query('create table if not exists _infra_check (id int primary key, at timestamptz)');
  await c.query('insert into _infra_check (id, at) values (1, now()) on conflict (id) do update set at = now()');
  const r = await c.query('select at from _infra_check where id = 1');
  await c.end();
  return { db: v.rows[0].db, server: v.rows[0].v.split(' ').slice(0, 2).join(' '), wrote: r.rows[0].at };
});

await run('alchemy_rpc', async () => {
  const r = await fetch(`https://base-mainnet.g.alchemy.com/v2/${ALCH}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) });
  const j = await r.json();
  if (!j.result) throw new Error(JSON.stringify(j).slice(0, 120));
  return { block: parseInt(j.result, 16) };
});

await run('alchemy_archive', async () => { // archive depth is what Flows needs
  const r = await fetch(`https://base-mainnet.g.alchemy.com/v2/${ALCH}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['0x4200000000000000000000000000000000000006', '0x2000000'] }) });
  const j = await r.json();
  if (!j.result) throw new Error(JSON.stringify(j.error || j).slice(0, 120));
  return { at_block: 0x2000000 };
});

await run('alchemy_webhook', async () => {
  const id = process.env.ALCH_WEBHOOK_ID || 'wh_n8pxw2vbek7lbt8v';
  const r = await fetch(`https://dashboard.alchemy.com/api/webhook-addresses?webhook_id=${id}&limit=100&after=`, { headers: { 'X-Alchemy-Token': process.env.ALCH_NOTIFY_TOKEN } });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 150));
  return { id, addresses_first_page: (j.data || []).length, total: j.pagination ? j.pagination.total_count : undefined };
});

await run('r2', async () => {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
  // no ListBuckets: a token scoped to one bucket is denied that call, which is the correct, tighter scope
  const body = JSON.stringify({ hello: 'reef', at: out.at });
  await s3.send(new PutObjectCommand({ Bucket: 'reef-data', Key: '_infra_check.json', Body: body, ContentType: 'application/json' }));
  const got = await (await s3.send(new GetObjectCommand({ Bucket: 'reef-data', Key: '_infra_check.json' }))).Body.transformToString();
  await s3.send(new DeleteObjectCommand({ Bucket: 'reef-data', Key: '_infra_check.json' }));
  if (got !== body) throw new Error('read back did not match write');
  return { bucket: 'reef-data', wrote_and_read: true };
});

await run('fly', async () => {
  const r = await fetch('https://api.machines.dev/v1/apps?org_slug=personal', { headers: { Authorization: `Bearer ${process.env.FLY_API_TOKEN}` } });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 100)}`);
  const j = await r.json();
  return { apps: (j.apps || []).map((a) => a.name) };
});

await run('bitquery', async () => {
  const r = await fetch('https://streaming.bitquery.io/graphql', { method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + process.env.BITQUERY_TOKEN },
    body: JSON.stringify({ query: `query { EVM(dataset: archive, network: base) { TokenHolders(date: "${new Date().toISOString().slice(0, 10)}", tokenSmartContract: "0x532f27101965dd16442e59d40670faf5ebb142e4", limit: {count: 3}, orderBy: {descendingByField: "Balance_Amount"}) { Holder { Address } Balance { Amount } } } }` }) });
  const j = await r.json();
  const rows = j.data && j.data.EVM && j.data.EVM.TokenHolders;
  if (!rows || !rows.length) throw new Error(JSON.stringify(j.errors || j).slice(0, 150));
  const top = Number(rows[0].Balance.Amount);
  return { top_holder_balance: top, sane: top < 1e30 };
});

await run('site', async () => {
  const r = await fetch('https://usereef.io/data/index.json', { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const a = await fetch('https://usereef.io/api/auth');
  return { tokens: (j.tokens || []).length, generated_at: j.generated_at, api_auth: a.status };
});

out.summary = Object.entries(out.checks).map(([k, v]) => `${v.ok ? 'PASS' : 'FAIL'} ${k}`).join(', ');
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/infra_check.json', JSON.stringify(out, null, 1));
console.log('\n' + out.summary);
