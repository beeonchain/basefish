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
const LABEL_TTL_DAYS = 30, ARKHAM_MAX_LOOKUPS = 300;
let arkhamBudget = ARKHAM_MAX_LOOKUPS, arkhamBase = null;

function parseArkham(payload) {
  // response may be flat or keyed per-chain; walk it for arkhamEntity/arkhamLabel (+ id, socials)
  const found = { name: null, type: null, label: null, id: null, twitter: null, website: null };
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    if (o.arkhamEntity && !found.name) {
      const e = o.arkhamEntity;
      found.name = e.name || null; found.type = e.type || null; found.id = e.id || null;
      found.twitter = e.twitter || e.twitterUsername || null; found.website = e.website || e.websiteLink || null;
    }
    if (o.arkhamLabel && !found.label) found.label = o.arkhamLabel.name || null;
    if (!found.name || !found.label) for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(payload, 0);
  return found;
}
function pickSocials(payload) {
  const out = { twitter: null, website: null };
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && v) {
        const kl = k.toLowerCase();
        if (!out.twitter && (kl === 'twitter' || kl === 'twitterusername' || kl === 'x')) out.twitter = v;
        if (!out.website && (kl === 'website' || kl === 'websitelink' || kl === 'site' || kl === 'url') && /^https?:/.test(v)) out.website = v;
      } else if (typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(payload, 0);
  return out;
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
        const rec = { name: info.name, type: info.type, label: info.label, id: info.id, twitter: info.twitter, website: info.website, ts: Date.now() };
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
let profileBudget = 600; // total arkham profile calls per run
let loggedShapes = false;

async function arkhamGet(pathname) {
  if (!ARKHAM_KEY || profileBudget <= 0) return null;
  const bases = arkhamBase ? [arkhamBase] : ARKHAM_BASES;
  for (const base of bases) {
    try {
      const r = await fetch(base + pathname, { headers: { 'API-Key': ARKHAM_KEY, accept: 'application/json' } });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 2500)); continue; }
      if (!r.ok) { if (!loggedShapes) console.log(`  arkham ${r.status} on ${pathname.split('?')[0]} :: ${(await r.text()).slice(0, 140)}`); continue; }
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
  return { totalUsd, holdings: dedup.slice(0, 15) };
}

function parseTransfers(t, self) {
  let arr = (t && (t.transfers || t.result || (Array.isArray(t) ? t : []))) || [];
  const meaningful = arr.filter(x => num2(x.historicalUSD ?? x.usd ?? x.usdValue) >= 1);
  if (meaningful.length >= 3) arr = meaningful;
  return arr.slice(0, 40).map(x => {
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

let loggedEntity = false, loggedEntityFull = false;
async function fixSocials(addr, prof) {
  // resolve entity id + socials even for fresh profiles (runs once per address)
  const a = addr.toLowerCase();
  const lc = labelCache[a];
  if (!lc || !lc.name) return prof;
  if (lc.idChecked && lc.slugTried) return prof;
  if (profileBudget < 3) return prof;
  lc.idChecked = true;
  const re = await arkhamGet(`/intelligence/address/${addr}/all`);
  if (re) {
    const pi = parseArkham(re);
    if (!loggedEntity) { loggedEntity = true;
      const findEnt = (o,d)=>{if(!o||typeof o!=='object'||d>3)return null;if(o.arkhamEntity)return o.arkhamEntity;for(const v of Object.values(o)){const r2=findEnt(v,d+1);if(r2)return r2}return null};
      console.log('  [shape] arkhamEntity:', JSON.stringify(findEnt(re,0)||{}).slice(0, 400));
    }
    lc.id = lc.id || pi.id; lc.twitter = lc.twitter || pi.twitter; lc.website = lc.website || pi.website;
  }
  if (!lc.twitter && !lc.website && !lc.slugTried) {
    lc.slugTried = true;
    const slug = lc.id || String(lc.name).toLowerCase().replace(/:.*$/, '').trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const ei = await arkhamGet(`/intelligence/entity/${encodeURIComponent(slug)}`);
    if (ei) {
      if (!loggedEntityFull) { loggedEntityFull = true; console.log('  [shape] entity(' + slug + '):', JSON.stringify(ei).slice(0, 600)); }
      const s2 = pickSocials(ei); lc.twitter = lc.twitter || s2.twitter; lc.website = lc.website || s2.website;
      lc.id = lc.id || slug;
    }
  }
  if (prof && prof.entity && (lc.twitter || lc.website)) {
    prof.entity.twitter = prof.entity.twitter || lc.twitter;
    prof.entity.website = prof.entity.website || lc.website;
    prof.entity.id = prof.entity.id || lc.id;
    return prof;
  }
  return prof;
}
const PF_POINTS = 10, PF_DAYS = 60;
async function backfillPortfolioHistory(addr, prof) {
  // real portfolio-value history from Arkham (portfolio?time= accepts historical timestamps)
  if (!prof || prof.pfB || (prof.history || []).length >= PF_POINTS - 2 || profileBudget < PF_POINTS + 5) return prof;
  const pts = [];
  for (let i = PF_POINTS - 1; i >= 1; i--) {
    const ts = Date.now() - i * (PF_DAYS / (PF_POINTS - 1)) * 864e5;
    const pf = await arkhamGet(`/portfolio/address/${addr}?time=${Math.round(ts)}`);
    const parsed = parsePortfolio(pf);
    if (parsed && parsed.totalUsd > 0) pts.push({ ts: new Date(ts).toISOString(), usd: Math.round(parsed.totalUsd) });
  }
  if (pts.length >= 3) {
    const merged = [...pts, ...(prof.history || [])].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const dedup = merged.filter((x, i) => i === 0 || new Date(x.ts) - new Date(merged[i-1].ts) > 36e5);
    prof.history = dedup.slice(-400);
    prof.pfB = true;
    console.log(`  pf-history backfilled ${addr.slice(0, 10)} (${pts.length} pts)`);
  }
  return prof;
}
async function enrichWalletProfile(addr) {
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  const p = path.join(WALLET_DIR, addr.toLowerCase() + '.json');
  let oldHistory = [], oldPos = {}, oldProf = null;
  try {
    const old = JSON.parse(fs.readFileSync(p, 'utf8'));
    oldHistory = old.history || []; oldPos = old.posHistory || {}; oldProf = old;
    if (old.v === 3 && Date.now() - new Date(old.updated).getTime() < WALLET_TTL_H * 36e5) {
      // fresh profile: still run the cheap upgrade + heal passes
      const before = JSON.stringify({ e: old.entity, h: (old.history||[]).length, b: old.pfB, pf: !!old.portfolio, tr: (old.transfers||[]).length });
      await fixSocials(addr, old);
      await backfillPortfolioHistory(addr, old);
      // heal: restore portfolio/transfers lost to an exhausted-budget run
      if (!old.portfolio && profileBudget >= 5) {
        const pf2 = parsePortfolio(await arkhamGet(`/portfolio/address/${addr}?time=${Date.now()}`));
        if (pf2 && pf2.totalUsd > 0) old.portfolio = pf2;
      }
      if (!(old.transfers || []).length && profileBudget >= 5) {
        const tr2 = await arkhamGet(`/transfers?base=${addr}&limit=40&sortDir=desc&usdGte=1`);
        const p2 = tr2 ? parseTransfers(tr2, addr) : [];
        if (p2.length) old.transfers = p2;
      }
      if (JSON.stringify({ e: old.entity, h: (old.history||[]).length, b: old.pfB, pf: !!old.portfolio, tr: (old.transfers||[]).length }) !== before) fs.writeFileSync(p, JSON.stringify(old));
      return;
    }
  } catch {}
  if (profileBudget < 15) return; // not enough budget to finish properly — keep old data intact
  // entity comes from the label cache (filled by arkhamLookup) — no duplicate intel call
  const cached = labelCache[addr.toLowerCase()] || null;
  const intel = cached ? null : await arkhamGet(`/intelligence/address/${addr}/all`);
  const portfolio = await arkhamGet(`/portfolio/address/${addr}?time=${Date.now()}`)
    || await arkhamGet(`/portfolio/address/${addr}`);
  const transfers = await arkhamGet(`/transfers?base=${addr}&limit=40&sortDir=desc&usdGte=1`);
  if (!cached && !intel && !portfolio && !transfers) return;
  if (!loggedShapes && (portfolio || transfers)) {
    loggedShapes = true;
    if (portfolio) console.log('  [shape] portfolio keys:', Object.keys(portfolio).slice(0, 12).join(','));
    if (transfers) console.log('  [shape] transfers keys:', Object.keys(transfers).slice(0, 12).join(','));
  }
  let ent = cached ? { name: cached.name, type: cached.type, label: cached.label, id: cached.id || null, twitter: cached.twitter || null, website: cached.website || null } : parseArkham(intel || {});
  // older cache entries lack the entity id — refresh intel once for named entities so socials can resolve
  if (cached && ent.name && !ent.id && !cached.idChecked) {
    const re = await arkhamGet(`/intelligence/address/${addr}/all`);
    if (re) { const pi = parseArkham(re); ent.id = pi.id; ent.twitter = ent.twitter || pi.twitter; ent.website = ent.website || pi.website; }
    const lc = labelCache[addr.toLowerCase()]; if (lc) { lc.idChecked = true; lc.id = ent.id || lc.id; lc.twitter = lc.twitter || ent.twitter; lc.website = lc.website || ent.website; }
  }
  // fetch entity-level socials once when we know the entity but lack socials
  if (ent.id && !ent.twitter && !ent.website) {
    const ei = await arkhamGet(`/intelligence/entity/${encodeURIComponent(ent.id)}`);
    if (ei) { const s2 = pickSocials(ei); ent.twitter = ent.twitter || s2.twitter; ent.website = ent.website || s2.website;
      const lc = labelCache[addr.toLowerCase()]; if (lc) { lc.twitter = lc.twitter || s2.twitter; lc.website = lc.website || s2.website; } }
  }
  const port = parsePortfolio(portfolio);
  // own balance-history: one point per refresh cycle, grows forever (capped)
  const history = oldHistory.slice(-400);
  if (port && port.totalUsd > 0) {
    const last = history[history.length - 1];
    if (!last || Date.now() - new Date(last.ts).getTime() > 6 * 36e5) history.push({ ts: new Date().toISOString(), usd: Math.round(port.totalUsd) });
  }
  const newTr = transfers ? parseTransfers(transfers, addr) : [];
  let prof = ({
    v: 3, addr, updated: new Date().toISOString(),
    posHistory: oldPos, pfB: oldProf ? !!oldProf.pfB : false,
    entity: (ent && (ent.name || ent.label)) ? ent : ((oldProf && oldProf.entity) || ent),
    portfolio: port || (oldProf && oldProf.portfolio) || null,
    history,
    transfers: newTr.length ? newTr : ((oldProf && oldProf.transfers) || []),
  });
  await fixSocials(addr, prof);
  await backfillPortfolioHistory(addr, prof);
  fs.writeFileSync(p, JSON.stringify(prof));
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
if (ARKHAM_KEY) {
  const named = Object.entries(labelCache).find(([, v]) => v && v.name);
  if (named) {
    try {
      const dbg = await arkhamGet(`/intelligence/address/${named[0]}/all`);
      console.log(`[debug] /all for ${named[1].name} (${named[0].slice(0, 10)}):`, JSON.stringify(dbg).slice(0, 700));
    } catch (e) {}
  }
}
let logoCache = {};
try { logoCache = JSON.parse(fs.readFileSync('data/logos.json', 'utf8')); } catch {}
async function tokenLogo(t) {
  const hit = logoCache[t.sym];
  if (hit && Date.now() - (hit.ts || 0) < 7 * 864e5) return hit.url;
  if (!t.coingecko) return hit ? hit.url : null;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${t.coingecko}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`);
    if (r.ok) { const d = await r.json(); const url = (d.image && (d.image.small || d.image.large)) || null;
      if (url) { logoCache[t.sym] = { url, ts: Date.now() }; return url; } }
  } catch (e) {}
  return hit ? hit.url : null;
}
const index = { generated_at: new Date().toISOString(), tokens: [] };

// ---- 30d position-history backfill (real on-chain data via to_block) ----
const HIST_POINTS = 10, HIST_DAYS = 30, HIST_TOP = 15;
let histBlocks = null; // shared dates→blocks across tokens
async function getHistBlocks() {
  if (histBlocks) return histBlocks;
  histBlocks = [];
  for (let i = HIST_POINTS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * (HIST_DAYS / (HIST_POINTS - 1)) * 864e5);
    try {
      const r = await j(`${M}/dateToBlock?chain=${cfg.chain}&date=${encodeURIComponent(d.toISOString())}`);
      histBlocks.push({ ts: d.toISOString(), block: r.block });
    } catch (e) { console.log('  dateToBlock failed:', e.message.slice(0, 80)); }
  }
  return histBlocks;
}
async function backfillPositions(t, top) {
  const c = t.contract.toLowerCase();
  const blocks = await getHistBlocks();
  if (!blocks.length) return;
  // token price at each block (shared across wallets)
  const prices = [];
  for (const b of blocks) {
    try { prices.push(Number((await j(`${M}/erc20/${c}/price?chain=${cfg.chain}&to_block=${b.block}`)).usdPrice) || 0); }
    catch (e) { prices.push(0); }
  }
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  let done = 0;
  for (const h of top.slice(0, HIST_TOP)) {
    const p = path.join(WALLET_DIR, h.addr.toLowerCase() + '.json');
    let cur2 = {}; try { cur2 = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    const ph = cur2.posHistory || {};
    if (ph[t.sym] && ph[t.sym].length >= HIST_POINTS - 2) continue; // already backfilled
    const pts = [];
    for (let i = 0; i < blocks.length; i++) {
      try {
        let amt = 0;
        try {
          const bal = await j(`${M}/wallets/${h.addr}/tokens?chain=${cfg.chain}&token_addresses%5B0%5D=${c}&to_block=${blocks[i].block}`);
          const row = (bal.result || [])[0];
          amt = row ? Number(row.balance_formatted) || 0 : 0;
        } catch (e1) {
          // fallback: classic erc20 balances endpoint (raw balance + decimals)
          const bal2 = await j(`${M}/${h.addr}/erc20?chain=${cfg.chain}&token_addresses%5B0%5D=${c}&to_block=${blocks[i].block}`);
          const row2 = (Array.isArray(bal2) ? bal2 : bal2.result || [])[0];
          amt = row2 ? Number(row2.balance) / Math.pow(10, Number(row2.decimals) || 18) : 0;
        }
        pts.push({ ts: blocks[i].ts, usd: Math.round(amt * (prices[i] || 0)), amount: amt });
      } catch (e) { /* skip point */ }
    }
    if (pts.length >= 3) {
      ph[t.sym] = pts;
      cur2.posHistory = ph; cur2.addr = cur2.addr || h.addr;
      fs.writeFileSync(p, JSON.stringify(cur2));
      done++;
    }
  }
  if (done) console.log(`  backfilled 30d position history for ${done} wallets`);
}

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
      for (const h of top.slice(0, WALLET_DETAIL_PER_TOKEN)) { try { await fixSocials(h.addr, null); } catch (e) {} }
      for (const h of top.slice(0, WALLET_DETAIL_PER_TOKEN)) {
        try { await enrichWalletProfile(h.addr); } catch (e) { console.log('  profile err', h.addr.slice(0, 10), e.message.slice(0, 60)); }
      }
      console.log(`  wallet profiles refreshed (budget left ${profileBudget})`);
    }
    try { await backfillPositions(t, top); } catch (e) { console.log('  backfill err:', e.message.slice(0, 90)); }

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

    const logo = await tokenLogo(t);
    const out = {
      sym: t.sym, name: t.name, color: t.color, contract: t.contract, logo,
      price: usd, chg, mcap, holders,
      generated_at: index.generated_at,
      holdersTop: top, recent,
    };
    fs.writeFileSync(path.join('data', `${t.sym.toLowerCase()}.json`), JSON.stringify(out));
    index.tokens.push({ sym: t.sym, name: t.name, color: t.color, contract: t.contract, logo, price: usd, chg, mcap, holders });
    console.log(`  ok: price=$${usd} mcap=$${Math.round(mcap).toLocaleString()} holders=${holders}`);
  } catch (e) {
    console.error(`  FAILED ${t.sym}:`, e.message.slice(0, 160));
    // Moralis down (quota etc): keep previous data, but Arkham + logos still work
    const p = path.join('data', `${t.sym.toLowerCase()}.json`);
    if (fs.existsSync(p)) {
      const old = JSON.parse(fs.readFileSync(p, 'utf8'));
      const logo = await tokenLogo(t);
      if (logo && !old.logo) { old.logo = logo; fs.writeFileSync(p, JSON.stringify(old)); }
      index.tokens.push({ sym: old.sym, name: old.name, color: old.color, contract: old.contract, logo: old.logo || logo, price: old.price, chg: old.chg, mcap: old.mcap, holders: old.holders });
      if (ARKHAM_KEY) {
        for (const h of (old.holdersTop || []).slice(0, WALLET_DETAIL_PER_TOKEN)) { try { await fixSocials(h.addr, null); } catch (e2) {} }
        for (const h of (old.holdersTop || []).slice(0, WALLET_DETAIL_PER_TOKEN)) {
          try { await enrichWalletProfile(h.addr); } catch (e2) { }
        }
        console.log(`  arkham-only enrichment done (profile budget left ${profileBudget})`);
      }
    }
  }
}

if (!index.tokens.length) { console.error('No token data fetched at all — aborting without writing index.'); process.exit(1); }
fs.writeFileSync(LABELS_PATH, JSON.stringify(labelCache));
fs.writeFileSync('data/logos.json', JSON.stringify(logoCache));
fs.writeFileSync('data/index.json', JSON.stringify(index));
console.log(`\nWrote data/index.json with ${index.tokens.length} tokens. Label cache: ${Object.keys(labelCache).length} addresses${ARKHAM_KEY ? '' : ' (no ARKHAM_API_KEY — enrichment skipped)'}.`);
