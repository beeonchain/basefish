// Daily token discovery — which Base tokens does WALLETSEA track?
// Source: GeckoTerminal (CoinGecko's DEX API, keyless): pools by 24h volume + trending pools on Base →
// base tokens → info (mcap/fdv/liquidity/logo/coingecko id) → filter → rank → tokens.config.json.
// Keeps every manual entry and every token added from the site ("Fetch full data"); replaces the auto set.
import fs from 'node:fs';

const CFG = 'tokens.config.json';
const LIMITS = { autoTop: 60, trending: 10, total: 80, hot: 18 };
const MIN = { mcap: 1_500_000, liq: 120_000, liqTrending: 60_000 };
// not "holders of a Base project": stables, wrapped/bridged/staked majors, RWA/treasury wrappers, LP receipts
const EXCL_SYM = /^(usdc|usdbc|usdt|dai|eurc|eur\w*|usde|susde|usds|susds|gho|frax|lusd|tusd|pyusd|ausd|apxusd|apyusd|usdai|susdai|crvusd|reusd|usd0|syrupusdc|steakusdc|sdai|ustbl|eutbl|thbill|jtrsy|jaaa|usad|weth|eth|aweth|cbeth|acbeth|wsteth|weeth|rseth|wrseth|reth|lseth|ezeth|steth|meth|sfrxeth|frxeth|ynETH|wbtc|cbbtc|tbtc|lbtc|fbtc|solvbtc|unibtc|gtbtc|clbtc|xbtc|jitosol|wsol|sol|bnb|wbnb|matic|pol|avax|link|aave|comp|crv|snx|1inch|cake|uni|sushi|bal|ldo|eigen|pendle|ena|ethfi|zro|icp|tao|tel|chz|trac|zen|xcn|morpho|op|arb)$/i;
const EXCL_NAME = /wrapped|bridged|staked|restaked|stablecoin|usd coin|tether|treasury|t-bill|vault|receipt|\blp\b|liquidity|aave base|compound|morpho vault|steak/i;
const EXCL_ADDR = new Set(['0x4200000000000000000000000000000000000006', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42', '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452', '0xe31ee12bdfdd0573d634124611e85338e2cbf0cf']);
const PALETTE = ['#4C8DFF', '#F2C14E', '#A78BFA', '#22C55E', '#F97316', '#EC4899', '#14B8A6', '#EAB308', '#8B5CF6', '#EF4444', '#06B6D4', '#84CC16', '#F43F5E', '#6366F1', '#10B981', '#D946EF', '#0EA5E9', '#F59E0B', '#A3E635', '#FB7185'];
const colorFor = (sym) => PALETTE[[...sym].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];

const GT = 'https://api.geckoterminal.com/api/v2';
async function gt(u) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(GT + u, { headers: { accept: 'application/json;version=20230302' } });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 2500 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`geckoterminal ${r.status} ${u}`);
    return r.json();
  }
  throw new Error('geckoterminal rate limited ' + u);
}
const num = (v) => (v == null ? 0 : Number(v) || 0);

export async function discover({ pages = 20 } = {}) {
  const cand = new Map(); // addr -> { addr, vol, trending, src:Set }
  const note = (id, vol, trending, src) => { const a = String(id || '').replace(/^base_/, '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a) || EXCL_ADDR.has(a)) return; const c = cand.get(a) || { addr: a, vol: 0, trending: false, src: new Set() }; c.vol += vol || 0; c.src.add(src); if (trending) c.trending = true; cand.set(a, c); };
  // 1) GeckoTerminal: pools by 24h volume (Base-native activity) + trending pools
  for (let p = 1; p <= pages; p++) {
    try { const d = await gt(`/networks/base/pools?page=${p}&sort=h24_volume_usd_desc`); for (const x of d.data || []) note(x.relationships.base_token.data.id, num(x.attributes.volume_usd && x.attributes.volume_usd.h24), false, 'pools'); }
    catch (e) { console.log('  pools page', p, e.message.slice(0, 60)); break; }
    await new Promise((s) => setTimeout(s, 2100)); // GT free tier: 30 req/min
  }
  try { const tr = await gt('/networks/base/trending_pools?page=1'); for (const x of tr.data || []) note(x.relationships.base_token.data.id, num(x.attributes.volume_usd && x.attributes.volume_usd.h24), true, 'trending'); } catch (e) { console.log('  trending', e.message.slice(0, 60)); }
  // 2) CoinGecko categories: Base meme coins (native by definition) + Base ecosystem (drop multi-chain majors)
  try {
    const cg = async (u) => { const r = await fetch('https://api.coingecko.com/api/v3' + u, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('coingecko ' + r.status); return r.json(); };
    const list = await cg('/coins/list?include_platform=true');
    const plat = new Map(); for (const c of list) if (c.platforms && c.platforms.base) plat.set(c.id, { base: String(c.platforms.base).toLowerCase(), n: Object.keys(c.platforms).length });
    await new Promise((s) => setTimeout(s, 2500));
    const meme = await cg('/coins/markets?vs_currency=usd&category=base-meme-coins&order=market_cap_desc&per_page=100&page=1');
    for (const c of meme) { const p = plat.get(c.id); if (p) note(p.base, c.total_volume, false, 'cg-meme'); }
    await new Promise((s) => setTimeout(s, 2500));
    const eco = await cg('/coins/markets?vs_currency=usd&category=base-ecosystem&order=market_cap_desc&per_page=250&page=1');
    for (const c of eco) { const p = plat.get(c.id); if (p && p.n <= 3) note(p.base, c.total_volume, false, 'cg-eco'); } // ≤3 chains ≈ Base-native, not a bridged major
  } catch (e) { console.log('  coingecko categories skipped:', e.message.slice(0, 80)); }
  // 3) token facts from GeckoTerminal, 30 per call
  const addrs = [...cand.keys()], info = new Map();
  for (let i = 0; i < addrs.length; i += 30) {
    try { const d = await gt(`/networks/base/tokens/multi/${addrs.slice(i, i + 30).join(',')}`);
      for (const t of d.data || []) { const a = t.attributes; info.set(String(a.address).toLowerCase(), { sym: a.symbol, name: a.name, mcap: num(a.market_cap_usd), fdv: num(a.fdv_usd), liq: num(a.total_reserve_in_usd), vol: num(a.volume_usd && a.volume_usd.h24), logo: a.image_url && !/missing/.test(a.image_url) ? a.image_url : null, cg: a.coingecko_coin_id || null, price: num(a.price_usd) }); }
    } catch (e) { console.log('  token info batch', i, e.message.slice(0, 60)); }
    await new Promise((s) => setTimeout(s, 2100));
  }
  const rows = [];
  for (const [a, c] of cand) {
    const t = info.get(a); if (!t || !t.sym) continue;
    const cap = t.mcap || t.fdv; if (!cap) continue;
    if (EXCL_SYM.test(t.sym) || EXCL_NAME.test(t.name || '') || EXCL_NAME.test(t.sym)) continue;
    if (t.liq < (c.trending ? MIN.liqTrending : MIN.liq)) continue;
    if (cap < MIN.mcap && !c.trending) continue;
    rows.push({ addr: a, sym: t.sym.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'TOKEN', name: t.name, cap, liq: t.liq, vol: t.vol || c.vol, trending: c.trending, logo: t.logo, cg: t.cg, src: [...c.src] });
  }
  rows.sort((x, y) => y.cap - x.cap);
  const top = rows.slice(0, LIMITS.autoTop);
  const trending = rows.filter((r) => r.trending && !top.includes(r)).sort((x, y) => y.vol - x.vol).slice(0, LIMITS.trending);
  return { picked: [...top, ...trending], candidates: rows.length, scanned: cand.size };
}

export function mergeConfig(cfg, picked) {
  const tokens = (cfg.tokens || []);
  const manual = tokens.filter((t) => !t.auto);         // hand-curated + site-added: never removed here
  const byAddr = new Map(manual.map((t) => [String(t.contract).toLowerCase(), t]));
  const syms = new Set(manual.map((t) => t.sym));
  const out = [...manual];
  for (const r of picked) {
    if (out.length >= LIMITS.total) break;
    if (byAddr.has(r.addr)) { const m = byAddr.get(r.addr); if (r.trending) m.trending = true; else delete m.trending; m.cap = Math.round(r.cap); continue; }
    let sym = r.sym; while (syms.has(sym)) sym = sym.slice(0, 10) + Math.floor(Math.random() * 90 + 10); syms.add(sym);
    const prev = tokens.find((t) => String(t.contract).toLowerCase() === r.addr) || {};
    const t = { sym, name: r.name, color: prev.color || colorFor(sym), contract: r.addr, exclude: prev.exclude || [], auto: true, cap: Math.round(r.cap) };
    if (r.cg) t.coingecko = r.cg; if (r.logo) t.logoUrl = r.logo; if (r.trending) t.trending = true;
    out.push(t);
  }
  // tiers: the original five + the biggest/most-traded run every 2h, everything else daily
  const rank = new Map(picked.map((r, i) => [r.addr, i]));
  const hotBy = [...out].sort((a, b) => (b.cap || 0) - (a.cap || 0));
  const hot = new Set(hotBy.slice(0, LIMITS.hot).map((t) => t.contract.toLowerCase()));
  for (const t of out) { const a = t.contract.toLowerCase(); t.tier = (!t.auto && !t.addedBy) || hot.has(a) || t.trending ? 'hot' : 'daily'; if (rank.has(a)) t.rank = rank.get(a) + 1; }
  return { ...cfg, tokens: out, discovered_at: new Date().toISOString() };
}

if (process.argv[1] && /discover\.mjs$/.test(process.argv[1])) {
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  const { picked, candidates, scanned } = await discover();
  const next = mergeConfig(cfg, picked);
  fs.writeFileSync(CFG, JSON.stringify(next, null, 2) + '\n');
  console.log(`discover: scanned ${scanned} tokens, ${candidates} passed filters, picked ${picked.length}; config now ${next.tokens.length} tokens (${next.tokens.filter((t) => t.tier === 'hot').length} hot)`);
  console.log(next.tokens.map((t) => `${t.tier === 'hot' ? '🔥' : '·'} ${t.sym}${t.trending ? '📈' : ''} $${Math.round((t.cap || 0) / 1e6)}M`).join('  '));
}
