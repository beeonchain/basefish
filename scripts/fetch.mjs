// Basefish data fetcher — pulls top holders + prices from Moralis, writes static JSON into data/.
// Runs in GitHub Actions on a schedule. Requires MORALIS_API_KEY env var.
import fs from 'node:fs';
import path from 'node:path';

const KEY = process.env.MORALIS_API_KEY;
if (!KEY) { console.error('MORALIS_API_KEY missing'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync('tokens.config.json', 'utf8'));
const M = 'https://deep-index.moralis.io/api/v2.2';
const H = { 'X-API-Key': KEY, accept: 'application/json' };

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
    const top = kept.slice(0, 100);
    console.log(`  scanned ${seen}, kept ${kept.length}, top ${top.length}`);

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
fs.writeFileSync('data/index.json', JSON.stringify(index));
console.log(`\nWrote data/index.json with ${index.tokens.length} tokens.`);
