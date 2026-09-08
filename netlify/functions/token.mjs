// On-demand token lookup for the search box: GET /api/token?ca=0x…
// tracked → {tracked:true, sym}; untracked ERC-20 → metadata + price + top holders (Bitquery Holders cube, balances as of
// yesterday) so the site can show a "mini aquarium" instantly. Cached at the CDN for an hour.
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { json } from '../lib/store.mjs';

const RPC = process.env.ALCHEMY_RPC || 'https://base-mainnet.g.alchemy.com/v2/alch_XrAYuto21vrOGXzYZX9OP';
const ERC20 = parseAbi(['function symbol() view returns (string)', 'function name() view returns (string)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)']);
const BURN = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000001']);
const CFG_RAW = 'https://raw.githubusercontent.com/beeonchain/basefish/main/tokens.config.json';

async function bqHolders(contract, date, limit = 120) {
  const tok = process.env.BITQUERY_TOKEN; if (!tok) return { error: 'BITQUERY_TOKEN not configured' };
  const q = `query { EVM(dataset: archive, network: base) { Holders( date: "${date}"
      where:{ Currency:{ SmartContract:{ is:"${contract}" } } Balance:{ Amount:{ gt:"0", lt:"1000000000000000" } } }
      limit: {count: ${limit}} orderBy: {descending: Balance_Amount} ) { Holder { Address } Balance { Amount } } } }`;
  const r = await fetch('https://streaming.bitquery.io/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok, 'X-API-KEY': tok }, body: JSON.stringify({ query: q }) });
  if (!r.ok) return { error: 'bitquery http ' + r.status };
  const d = await r.json();
  if (d.errors) return { error: 'bitquery: ' + JSON.stringify(d.errors).slice(0, 120) };
  const rows = (d.data && d.data.EVM && d.data.EVM.Holders) || [];
  return { rows: rows.map((x) => ({ addr: String(x.Holder.Address).toLowerCase(), amount: Number(x.Balance.Amount) || 0 })).filter((x) => x.amount > 0) };
}

export default async (req) => {
  const url = new URL(req.url);
  const ca = String(url.searchParams.get('ca') || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ca)) return json({ error: 'ca must be a 0x address' }, 400);
  const H = { 'Netlify-CDN-Cache-Control': 'public, max-age=3600, durable', 'cache-control': 'public, max-age=300' };
  try {
    // 1) already tracked?
    const cfg = await fetch(CFG_RAW + '?t=' + Math.floor(Date.now() / 6e5)).then((r) => r.json()).catch(() => ({ tokens: [] }));
    const hit = (cfg.tokens || []).find((t) => String(t.contract).toLowerCase() === ca);
    if (hit) return new Response(JSON.stringify({ tracked: true, sym: hit.sym, name: hit.name }), { headers: { 'content-type': 'application/json', ...H } });
    // 2) is it a contract that speaks ERC-20?
    const client = createPublicClient({ chain: base, transport: http(RPC) });
    const code = await client.getBytecode({ address: ca });
    if (!code || code === '0x') return new Response(JSON.stringify({ tracked: false, isToken: false, kind: 'wallet' }), { headers: { 'content-type': 'application/json', ...H } });
    let sym, name, decimals = 18, supply = null;
    try {
      [sym, name, decimals] = await Promise.all([
        client.readContract({ address: ca, abi: ERC20, functionName: 'symbol' }),
        client.readContract({ address: ca, abi: ERC20, functionName: 'name' }),
        client.readContract({ address: ca, abi: ERC20, functionName: 'decimals' }),
      ]);
      try { supply = Number(formatUnits(await client.readContract({ address: ca, abi: ERC20, functionName: 'totalSupply' }), decimals)); } catch {}
    } catch { return new Response(JSON.stringify({ tracked: false, isToken: false, kind: 'contract' }), { headers: { 'content-type': 'application/json', ...H } }); }
    // 3) price (CoinGecko by contract + DexScreener, in parallel) and 4) holders — all at once
    const yday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const cgP = fetch(`https://api.coingecko.com/api/v3/coins/base/contract/${ca}`, { headers: { accept: 'application/json' } }).then((g) => (g.ok ? g.json() : null)).catch(() => null);
    const dsP = fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`).then((r) => r.json()).catch(() => null);
    const hbP = bqHolders(ca, yday, 120).catch((e) => ({ error: String(e.message || e).slice(0, 100) }));
    const [j, d, hb] = await Promise.all([cgP, dsP, hbP]);
    let price = 0, mcap = null, cgId = null, logo = null, chg = null;
    if (j) { cgId = j.id || null; logo = (j.image && (j.image.small || j.image.thumb)) || null; const m = j.market_data || {}; price = (m.current_price && m.current_price.usd) || 0; mcap = (m.market_cap && m.market_cap.usd) || null; chg = (m.price_change_percentage_24h != null) ? m.price_change_percentage_24h : null; }
    if (!price && d) { const p = (d.pairs || []).filter((x) => x.chainId === 'base').sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]; if (p) { price = Number(p.priceUsd) || 0; mcap = mcap || p.marketCap || p.fdv || null; chg = chg == null && p.priceChange ? p.priceChange.h24 : chg; logo = logo || (p.info && p.info.imageUrl) || null; } }
    const holders = (hb.rows || []).filter((h) => !BURN.has(h.addr) && h.addr !== ca).slice(0, 100)
      .map((h, i) => ({ rank: i + 1, addr: h.addr, amount: h.amount, pct: supply ? (h.amount / supply) * 100 : null, usd: h.amount * price }));
    const out = { tracked: false, isToken: true, contract: ca, sym: String(sym), name: String(name), decimals: Number(decimals), supply, price, mcap, chg, cgId, logo, asOf: yday, holders, holdersError: hb.error || null, topShare: supply && holders.length ? holders.reduce((s, h) => s + h.amount, 0) / supply * 100 : null };
    // don't let a holder-fetch failure (missing key, Bitquery hiccup) sit in the CDN cache for an hour
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', ...(hb.error ? { 'cache-control': 'no-store' } : H) } });
  } catch (e) { return json({ error: String(e.message || e).slice(0, 200) }, 500); }
};
export const config = { path: '/api/token' };
