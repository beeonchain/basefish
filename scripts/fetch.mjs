// Basefish data fetcher — pulls top holders + prices from Moralis, writes static JSON into data/.
// Runs in GitHub Actions on a schedule. Requires MORALIS_API_KEY env var.
import fs from 'node:fs';
import path from 'node:path';

const KEY = process.env.MORALIS_API_KEY;
if (!KEY) { console.error('MORALIS_API_KEY missing'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync('tokens.config.json', 'utf8'));
const M = 'https://deep-index.moralis.io/api/v2.2';
const H = { 'X-API-Key': KEY, accept: 'application/json' };

// ---- Arkham label enrichment (optional; skipped when no key) ----
const ARKHAM_KEY = process.env.ARKHAM_API_KEY || '';
const ARKHAM_BASES = ['https://api.arkm.com', 'https://api.arkhamintelligence.com'];
const LABELS_PATH = 'data/labels.json';
let labelCache = {};
try { labelCache = JSON.parse(fs.readFileSync(LABELS_PATH, 'utf8')); } catch {}
const LABEL_TTL_DAYS = 30, ARKHAM_MAX_LOOKUPS = 150;
let arkhamBudget = ARKHAM_MAX_LOOKUPS, arkhamBase = null;

function parseArkham(payload) {
  // response may be flat or keyed per-chain; walk it for arkhamEntity/arkhamLabel
  const found = { name: null, type: null, label: null };
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    if (o.arkhamEntity && !found.name) { found.name = o.arkhamEntity.name || null; found.type = o.arkhamEntity.type || null; }
    if (o.arkhamLabel && !found.label) found.label = o.arkhamLabel.name || null;
    if (!found.name || !found.label) for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(payload, 0);
  return found;
}

async function arkhamLookup(addr) {
  const a = addr.toLowerCase();
  const hit = labelCache[a];
  if (hit && (Date.now() - (hit.ts || 0)) < LABEL_TTL_DAYS * 864e5) return hit;
  if (!ARKHAM_KEY || arkhamBudget <= 0) return hit || null;
  const bases = arkhamBase ? [arkhamBase] : ARKHAM_BASES;
  for (const base of bases) {
    for (const path of [`/intelligence/address/${addr}/all`, `/intelligence/address/${addr}`]) {
      try {
        const r = await fetch(base + path, { headers: { 'API-Key': ARKHAM_KEY, accept: 'application/json' } });
        if (r.status === 429) { console.log('  arkham rate-limited, pausing'); await new Promise(s => setTimeout(s, 2000)); continue; }
        if (!r.ok) continue;
        arkhamBase = base; arkhamBudget--;
        const info = parseArkham(await r.json());
        const rec = { name: info.name, type: info.type, label: info.label, ts: Date.now() };
        labelCache[a] = rec;
        await new Promise(s => setTimeout(s, 250)); // be polite
        return rec;
      } catch (e) { /* try next */ }
    }
  }
  arkhamBudget--; // avoid hammering a dead endpoint
  return hit || null;
}

// entity types that should never count as a "holder fish"
const EXCLUDE_TYPES = new Set(['cex', 'exchange', 'bridge', 'dex', 'staking', 'burn', 'locker']);

// ---- Arkham wallet profile enrichment (top wallets only) ----
const WALLET_DIR = 'data/wallets';
const WALLET_DETAIL_PER_TOKEN = 25;
const WALLET_TTL_H = 12;
let profileBudget = 160; // total arkham profile calls per run
let loggedShapes = false;

async function arkhamGet(pathname) {
  if (!ARKHAM_KEY || profileBudget <= 0) return null;
  const bases = arkhamBase ? [arkhamBase] : ARKHAM_BASES;
  for (const base of bases) {
    try {
      const r = await fetch(base + pathname, { headers: { 'API-Key': ARKHAM_KEY, accept: 'application/json' } });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 2500)); continue; }
      if (!r.ok) { if (!loggedShapes) console.log(`  arkham ${r.status} on ${pathname.split('?')[0]}`); continue; }
      arkhamBase = base; profileBudget--;
      await new Promise(s => setTimeout(s, 300));
      return r.json();
    } catch (e) { /* next base */ }
  }
  return null;
}

function num2(x) { const n = Number(x); return isFinite(n) ? n : 0; }

function parsePortfolio(p) {
  if (!p) return null;
  // walk for arrays of balance-like objects
  const holdings = [];
  let totalUsd = 0;
  const walk = (o, chainHint, depth) => {
    if (!o || depth > 4) return;
    if (Array.isArray(o)) { o.forEach(v => walk(v, chainHint, depth + 1)); return; }
    if (typeof o !== 'object') return;
    const usd = num2(o.usd ?? o.usdValue ?? o.balanceUsd ?? o.valueUsd);
    const symb = o.symbol ?? o.tokenSymbol ?? (o.token && o.token.symbol);
    if (symb && usd > 0) {
      holdings.push({ sym: String(symb).toUpperCase().slice(0, 12), name: o.name || (o.token && o.token.name) || null,
        amount: num2(o.balance ?? o.amount ?? o.formattedBalance), usd, chain: o.chain || chainHint || null });
      return;
    }
    for (const [k, v] of Object.entries(o)) walk(v, /^[a-z0-9_]+$/.test(k) && typeof v === 'object' ? k : chainHint, depth + 1);
  };
  walk(p, null, 0);
  holdings.sort((a, b) => b.usd - a.usd);
  const seen = new Set(); const dedup = [];
  for (const h of holdings) { const k = h.sym + '|' + (h.chain || ''); if (seen.has(k)) continue; seen.add(k); dedup.push(h); }
  totalUsd = num2(p.totalBalance ?? p.totalUsd ?? p.total) || dedup.reduce((s, h) => s + h.usd, 0);
  return { totalUsd, holdings: dedup.slice(0, 10) };
}

function parseTransfers(t, self) {
  const arr = (t && (t.transfers || t.result || (Array.isArray(t) ? t : []))) || [];
  return arr.slice(0, 10).map(x => {
    const from = (x.fromAddress && (x.fromAddress.address || x.fromAddress)) || x.from || '';
    const to = (x.toAddress && (x.toAddress.address || x.toAddress)) || x.to || '';
    const fromLbl = (x.fromAddress && x.fromAddress.arkhamEntity && x.fromAddress.arkhamEntity.name) || (x.fromAddress && x.fromAddress.arkhamLabel && x.fromAddress.arkhamLabel.name) || null;
    const toLbl = (x.toAddress && x.toAddress.arkhamEntity && x.toAddress.arkhamEntity.name) || (x.toAddress && x.toAddress.arkhamLabel && x.toAddress.arkhamLabel.name) || null;
    const out = String(from).toLowerCase() === self.toLowerCase();
    return { ts: x.blockTimestamp || x.timestamp || x.time || null, dir: out ? 'out' : 'in',
      cp: out ? to : from, cpLabel: out ? toLbl : fromLbl,
      token: x.tokenSymbol || (x.token && x.token.symbol) || x.symbol || null,
      amount: num2(x.unitValue ?? x.amount ?? x.value), usd: num2(x.historicalUSD ?? x.usd ?? x.usdValue),
      hash: x.transactionHash || x.txHash || x.hash || null, chain: x.chain || null };
  });
}

async function enrichWalletProfile(addr) {
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  const p = path.join(WALLET_DIR, addr.toLowerCase() + '.json');
  try {
    const old = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Date.now() - new Date(old.updated).getTime() < WALLET_TTL_H * 36e5) return;
  } catch {}
  const [intel, portfolio, transfers] = [
    await arkhamGet(`/intelligence/address/${addr}/all`),
    await arkhamGet(`/portfolio/address/${addr}`),
    await arkhamGet(`/transfers?base=${addr}&limit=10&sortDir=desc`),
  ];
  if (!intel && !portfolio && !transfers) return;
  if (!loggedShapes && (portfolio || transfers)) {
    loggedShapes = true;
    if (portfolio) console.log('  [shape] portfolio keys:', Object.keys(portfolio).slice(0, 12).join(','));
    if (transfers) console.log('  [shape] transfers keys:', Object.keys(transfers).slice(0, 12).join(','));
  }
  const ent = parseArkham(intel || {});
  fs.writeFileSync(p, JSON.stringify({
    addr, updated: new Date().toISOString(),
    entity: { name: ent.name, type: ent.type, label: ent.label },
    portfolio: parsePortfolio(portfolio),
    transfers: transfers ? parseTransfers(transfers, addr) : [],
  }));
}

const BURN = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);
// Labels/entities we exclude from the top-100 (pools, CEXs, bridges, lockers)
const EXCLUDE_RX = /uniswap|aerodrome|pancake|sushi|baseswap|alien.?base|pool|liquidity|\blp\b|exchange|binance|coinbase|bybit|okx|gate|kucoin|mexc|bitget|htx|kraken|crypto\.com|bridge|locker|timelock|vesting|multisig deployer|wintermute|market maker/i;

async function j(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: H });
    if (r.ok) return r.json();
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (i + 1))); continue; }
    throw new Error(`${r.status} ${url} :: ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error(`rate-limited ${url}`);
}

fs.mkdirSync('data', { recursive: true });
const index = { generated_at: new Date().toISOString(), tokens: [] };

for (const t of cfg.tokens) {
  const c = t.contract.toLowerCase();
  console.log(`\n== ${t.sym} ${c}`);
  try {
    // price + 24h change
    const price = await j(`${M}/erc20/${c}/price?chain=${cfg.chain}&include=percent_change`);
    const usd = Number(price.usdPrice) || 0;
    const chg = Number(price['24hrPercentChange']) || 0;

    // metadata for supply
    const meta = (await j(`${M}/erc20/metadata?chain=${cfg.chain}&addresses%5B0%5D=${c}`))[0] || {};
    const supply = Number(meta.total_supply_formatted) || 0;
    const mcap = usd * supply;

    // holder count (best effort)
    let holders = null;
    try { holders = (await j(`${M}/erc20/${c}/holders?chain=${cfg.chain}`)).totalHolders ?? null; }
    catch (e) { console.log('holders count unavailable:', e.message.slice(0, 80)); }

    // top owners, paged; over-fetch so exclusions still leave 100
    const perToken = new Set((t.exclude || []).map(a => a.toLowerCase()));
    let cursor = '', kept = [], pages = 0, seen = 0;
    while (pages < 3 && kept.length < 130) {
      const q = `${M}/erc20/${c}/owners?chain=${cfg.chain}&order=DESC&limit=100${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await j(q);
      for (const o of page.result || []) {
        seen++;
        const a = (o.owner_address || '').toLowerCase();
        const label = o.owner_address_label || o.entity || '';
        if (BURN.has(a) || a === c || perToken.has(a)) continue;
        if (label && EXCLUDE_RX.test(label)) { console.log('  excluded:', a.slice(0, 10), label); continue; }
        const amount = Number(o.balance_formatted) || 0;
        kept.push({
          addr: o.owner_address,
          amount,
          pct: Number(o.percentage_relative_to_total_supply) || (supply ? amount / supply * 100 : 0),
          usd: Number(o.usd_value) || amount * usd,
          label: label || null,
          isContract: !!o.is_contract,
        });
      }
      cursor = page.cursor || '';
      pages++;
      if (!cursor) break;
    }
    kept.sort((a, b) => b.usd - a.usd);
    // Arkham enrichment for the head of the list (cache-first, budgeted)
    if (ARKHAM_KEY || Object.keys(labelCache).length) {
      const head = kept.slice(0, 120);
      for (const h of head) {
        const info = await arkhamLookup(h.addr);
        if (!info) continue;
        const name = info.name || info.label;
        if (name) h.label = h.label ? h.label : name;
        if (info.name) h.entity = info.name;
        if (info.type) h.entityType = info.type;
      }
    }
    const filtered = kept.filter(h => !(h.entityType && EXCLUDE_TYPES.has(String(h.entityType).toLowerCase())));
    const dropped = kept.length - filtered.length;
    if (dropped) console.log(`  arkham-excluded ${dropped} CEX/bridge/dex wallets`);
    const top = filtered.slice(0, 100);
    console.log(`  scanned ${seen}, kept ${kept.length}, top ${top.length}`);
    if (ARKHAM_KEY) {
      for (const h of top.slice(0, WALLET_DETAIL_PER_TOKEN)) {
        try { await enrichWalletProfile(h.addr); } catch (e) { console.log('  profile err', h.addr.slice(0, 10), e.message.slice(0, 60)); }
      }
      console.log(`  wallet profiles refreshed (budget left ${profileBudget})`);
    }

    // recent meaningful transfers
    let recent = [];
    try {
      const tr = await j(`${M}/erc20/${c}/transfers?chain=${cfg.chain}&limit=50`);
      recent = (tr.result || [])
        .map(x => ({
          hash: x.transaction_hash,
          from: x.from_address,
          to: x.to_address,
          amount: Number(x.value_decimal) || 0,
          usd: (Number(x.value_decimal) || 0) * usd,
          ts: x.block_timestamp,
        }))
        .filter(x => x.usd >= (cfg.minTransferUsd || 1000))
        .slice(0, 15);
    } catch (e) { console.log('transfers unavailable:', e.message.slice(0, 80)); }

    const out = {
      sym: t.sym, name: t.name, color: t.color, contract: t.contract,
      price: usd, chg, mcap, holders,
      generated_at: index.generated_at,
      holdersTop: top, recent,
    };
    fs.writeFileSync(path.join('data', `${t.sym.toLowerCase()}.json`), JSON.stringify(out));
    index.tokens.push({ sym: t.sym, name: t.name, color: t.color, contract: t.contract, price: usd, chg, mcap, holders });
    console.log(`  ok: price=$${usd} mcap=$${Math.round(mcap).toLocaleString()} holders=${holders}`);
  } catch (e) {
    console.error(`  FAILED ${t.sym}:`, e.message);
    // keep previous data file if it exists; still list token in index from old file
    const p = path.join('data', `${t.sym.toLowerCase()}.json`);
    if (fs.existsSync(p)) {
      const old = JSON.parse(fs.readFileSync(p, 'utf8'));
      index.tokens.push({ sym: old.sym, name: old.name, color: old.color, contract: old.contract, price: old.price, chg: old.chg, mcap: old.mcap, holders: old.holders });
    }
  }
}

if (!index.tokens.length) { console.error('No token data fetched at all — aborting without writing index.'); process.exit(1); }
fs.writeFileSync(LABELS_PATH, JSON.stringify(labelCache));
fs.writeFileSync('data/index.json', JSON.stringify(index));
console.log(`\nWrote data/index.json with ${index.tokens.length} tokens. Label cache: ${Object.keys(labelCache).length} addresses${ARKHAM_KEY ? '' : ' (no ARKHAM_API_KEY — enrichment skipped)'}.`);
