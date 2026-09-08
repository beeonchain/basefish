// Wallet tags — computed once per run over every tracked top-100, written onto each holder as
//   h.tags = ['WHALE','CT',…]   h.tagInfo = { WHALE: 'evidence text', … }
// Cheap tags need no extra calls (cross-token value, X identity, wallet age via funding cache).
// SNIPE / DIAMOND use the first-buy / outflow cache filled gradually by fetch.mjs (Arkham, budgeted).
export const TAG_TH = { whaleUsd: 250_000, megaUsd: 2_000_000, ogDays: 365, snipeMin: 30, diamondDays: 90 };
const musd = (v) => { const x = Math.abs(v); return x >= 1e6 ? '$' + (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? '$' + (x / 1e3).toFixed(0) + 'K' : '$' + Math.round(x); };

export function computeTags({ ALLTOPS, frCache, fundCache, manual, firstBuy, launch, contracts, now = Date.now() }) {
  // combined value across every tracked token (top-100 positions only)
  const combined = {}, tokensOf = {};
  for (const [sym, top] of Object.entries(ALLTOPS)) for (const h of top || []) {
    const a = h.addr.toLowerCase(); combined[a] = (combined[a] || 0) + (h.usd || 0); (tokensOf[a] = tokensOf[a] || []).push(sym);
  }
  const global = {}; // addr -> { tags:Set, info:{} }
  const G = (a) => global[a] || (global[a] = { tags: new Set(), info: {} });
  for (const [a, usd] of Object.entries(combined)) {
    if (usd >= TAG_TH.whaleUsd) { const g = G(a); g.tags.add('WHALE'); g.info.WHALE = `${musd(usd)} across ${tokensOf[a].length} tracked token${tokensOf[a].length === 1 ? '' : 's'}${usd >= TAG_TH.megaUsd ? ' · mega' : ''}`; }
    const fr = frCache.wallets && frCache.wallets[a];
    if (fr && fr.x) { const g = G(a); g.tags.add('CT'); g.info.CT = `@${fr.x}${fr.f ? ` · ${fr.f >= 1000 ? (fr.f / 1000).toFixed(fr.f >= 10000 ? 0 : 1) + 'K' : fr.f} followers` : ''}`; }
    const fd = fundCache[a];
    if (fd && fd.firstTs) { const age = (now - new Date(fd.firstTs).getTime()) / 864e5;
      if (age >= TAG_TH.ogDays && usd >= TAG_TH.whaleUsd) { const g = G(a); g.tags.add('OG'); g.info.OG = `on-chain since ${String(fd.firstTs).slice(0, 10)} (${Math.floor(age / 365)}y+) · ${musd(usd)}`; } }
  }
  // manual tags (admin /tag): { addr: { tags:[...], note, by, ts } } — added on top, never removed by the pipeline
  for (const [a0, m] of Object.entries(manual || {})) { const a = a0.toLowerCase(); if (!m || !m.tags) continue; const g = G(a); for (const t of m.tags) { g.tags.add(String(t).toUpperCase()); g.info[String(t).toUpperCase()] = g.info[String(t).toUpperCase()] || (m.note ? `curated · ${m.note}` : 'curated'); } }
  // per token: SNIPE / DIAMOND from the first-buy cache
  const perToken = {}; // sym -> addr -> { tags:Set, info }
  for (const [sym, top] of Object.entries(ALLTOPS)) {
    const c = contracts[sym]; if (!c) continue;
    const L = launch[c]; const pt = perToken[sym] = {};
    for (const h of top || []) {
      const a = h.addr.toLowerCase(), fb = firstBuy[`${a}:${c}`]; if (!fb || !fb.in) continue;
      const tIn = new Date(fb.in).getTime(); const e = { tags: new Set(), info: {} };
      if (L && tIn - new Date(L).getTime() <= TAG_TH.snipeMin * 60e3 && tIn >= new Date(L).getTime() - 3600e3) { e.tags.add('SNIPE'); e.info.SNIPE = `first buy ${Math.max(0, Math.round((tIn - new Date(L).getTime()) / 60e3))} min after launch (${String(L).slice(0, 10)})`; }
      const heldDays = (now - tIn) / 864e5;
      if (heldDays >= TAG_TH.diamondDays && fb.out === 'none') { e.tags.add('DIAMOND'); e.info.DIAMOND = `holding since ${String(fb.in).slice(0, 10)} (${Math.floor(heldDays)}d), never sent any out`; }
      if (e.tags.size) pt[a] = e;
    }
  }
  return { global, perToken };
}

// apply to a token file's holdersTop; returns true when anything changed
export function applyTags(d, sym, tagsOut) {
  let touched = false;
  for (const h of d.holdersTop || []) {
    const a = h.addr.toLowerCase(), g = tagsOut.global[a], p = tagsOut.perToken[sym] && tagsOut.perToken[sym][a];
    const tags = [...new Set([...(g ? g.tags : []), ...(p ? p.tags : [])])];
    const order = ['WHALE', 'OG', 'CT', 'DIAMOND', 'SNIPE']; tags.sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
    const info = { ...(g ? g.info : {}), ...(p ? p.info : {}) };
    const same = JSON.stringify(h.tags || []) === JSON.stringify(tags) && JSON.stringify(h.tagInfo || {}) === JSON.stringify(info);
    if (!same) { if (tags.length) { h.tags = tags; h.tagInfo = info; } else { delete h.tags; delete h.tagInfo; } touched = true; }
  }
  return touched;
}
