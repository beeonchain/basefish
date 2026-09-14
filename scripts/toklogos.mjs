// Logos for the tokens named in holder labels ("BNKR Top 100 Holder", "RAVE Top 20 Holder" …) that WHALARIUM does not
// track itself. Resolved once per symbol (DexScreener → CoinGecko), cached in data/toklogos.json, misses retried weekly.
import fs from 'node:fs';

const DATA = 'data';
const OUT = `${DATA}/toklogos.json`;
const MAX_NEW = Number(process.env.LOGO_MAX || 80);          // lookups per run (keeps the step short)
const RETRY_MS = 7 * 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const cache = rd(OUT) || {};
const index = rd(`${DATA}/index.json`) || {};
const tracked = new Map((index.tokens || []).map((t) => [String(t.sym).toUpperCase(), t]));

// 1. every symbol used in a "<SYM> Top N Holder" label across the holder files
const syms = new Map();
for (const f of fs.readdirSync(DATA)) {
  if (!f.endsWith('.json') || ['index.json', 'toklogos.json', 'alerts.json', 'alerts_state.json', 'codes.json', 'contracts.json', 'basenames.json', 'users.json', 'proposals.json', 'run_log.json'].includes(f)) continue;
  const d = rd(`${DATA}/${f}`); if (!d) continue;
  const hs = [...(Array.isArray(d.holdersTop) ? d.holdersTop : []), ...(Array.isArray(d.holders) ? d.holders : []), ...(Array.isArray(d.infra) ? d.infra : [])];
  for (const h of hs) for (const l of (h.labels || [])) {
    const m = String(l).match(/^(\S+?) top (\d+) holder$/i); if (!m) continue;
    const k = m[1].toUpperCase(); syms.set(k, (syms.get(k) || 0) + 1);
  }
}
const now = Date.now();
const todo = [...syms.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s)
  .filter((s) => { const c = cache[s]; return !c || (!c.logo && now - (c.t || 0) > RETRY_MS); });
console.log(`toklogos: ${syms.size} label symbols, ${Object.keys(cache).length} cached, ${todo.length} to resolve (max ${MAX_NEW})`);

async function gj(u, headers) {
  const r = await fetch(u, { headers: { accept: 'application/json', ...(headers || {}) } });
  if (r.status === 429) { await sleep(15000); return gj(u, headers); }
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.json();
}
async function dexscreener(sym) {
  const j = await gj(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`);
  const ps = (j.pairs || []).filter((p) => p.baseToken && p.baseToken.symbol && p.baseToken.symbol.toLowerCase() === sym.toLowerCase());
  ps.sort((a, b) => ((b.chainId === 'base') - (a.chainId === 'base')) || (((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0)));
  const p = ps.find((x) => x.info && x.info.imageUrl);
  return p ? { logo: p.info.imageUrl, ca: p.baseToken.address, name: p.baseToken.name, chain: p.chainId, src: 'dexscreener' } : null;
}
async function coingecko(sym) {
  const j = await gj(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(sym)}`);
  const c = (j.coins || []).find((x) => String(x.symbol).toLowerCase() === sym.toLowerCase());
  return c && c.large ? { logo: c.large, name: c.name, id: c.id, src: 'coingecko' } : null;
}

let n = 0, hit = 0;
for (const s of todo.slice(0, MAX_NEW)) {
  let r = null;
  const t = tracked.get(s);
  if (t && t.logo) r = { logo: t.logo, ca: t.contract, name: t.name, src: 'tracked' };
  if (!r) { try { r = await dexscreener(s); } catch (e) { console.log('  dexscreener', s, e.message); } await sleep(350); }
  if (!r) { try { r = await coingecko(s); } catch (e) { console.log('  coingecko', s, e.message); } await sleep(2200); }
  cache[s] = { ...(r || { logo: null }), t: now }; n++; if (r) hit++;
  console.log(`  ${s.padEnd(10)} ${r ? r.src + ' ' + r.logo : 'no logo'}`);
}
// symbols that are tracked always take the tracked logo (it may have changed)
for (const [s, t] of tracked) if (t.logo && syms.has(s)) cache[s] = { logo: t.logo, ca: t.contract, name: t.name, src: 'tracked', t: now };
fs.writeFileSync(OUT, JSON.stringify(cache));
console.log(`toklogos: resolved ${hit}/${n} this run, ${Object.values(cache).filter((c) => c.logo).length} logos total`);
