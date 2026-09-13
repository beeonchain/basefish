/* WHALARIUM shark avatar — an NFT-style layered character.
   One locked base shark (same pose, same framing, 1024×1024) + trait layers, every layer produced by editing that exact
   base image and cutting out only what changed, so any combination lines up. Layers stack in a fixed order, the way
   PFP collections are assembled: background → skin (full body) → clothes → chain → eyes → hat.
   Files: assets/avatar/<cat>_<id>.webp (1024, alpha) and <name>_s.webp (256 thumbs). Backgrounds are drawn procedurally. */
(function (root) {
  const SIZE = 1024;
  const RARITY = { common: { n: 'Common', c: '#5B616E' }, uncommon: { n: 'Uncommon', c: '#0E9F8A' }, rare: { n: 'Rare', c: '#8E4EC6' }, legendary: { n: 'Legendary', c: '#E5B838' } };
  const T = (n, r, w, extra) => ({ n, r, w, ...(extra || {}) });
  const TRAITS = {
    bg: {
      deep: T('Deep sea', 'common', 16), reef: T('Reef', 'common', 12), base: T('Base blue', 'common', 12), mint: T('Mint', 'common', 10), sand: T('Sandbar', 'common', 10),
      sunset: T('Sunset', 'uncommon', 8), lilac: T('Lilac', 'uncommon', 7), ink: T('Ink', 'uncommon', 6), coral: T('Coral pink', 'uncommon', 5),
      abyss: T('Abyss', 'rare', 3), aurora: T('Aurora', 'legendary', 1),
    },
    skin: {
      steel: T('Steel', 'common', 18), blue: T('Base blue', 'common', 16), navy: T('Navy', 'common', 12), teal: T('Teal', 'common', 12), sand: T('Sand', 'common', 10),
      coral: T('Coral', 'uncommon', 8), lavender: T('Lavender', 'uncommon', 7), olive: T('Olive', 'uncommon', 6), rose: T('Rose', 'uncommon', 5),
      onyx: T('Onyx', 'rare', 3), zombie: T('Zombie', 'rare', 2), gold: T('Gold', 'legendary', 1), emerald: T('Emerald', 'legendary', 1),
    },
    clothes: {
      none: T('Bare', 'common', 14, { none: true }), tee: T('White tee', 'common', 12), teeblue: T('Base tee', 'common', 10), hoodie: T('Hoodie', 'common', 10), tank: T('Tank top', 'common', 8),
      suit: T('Suit & tie', 'uncommon', 7), tracksuit: T('Tracksuit', 'uncommon', 7), hawaiian: T('Hawaiian', 'uncommon', 6), turtle: T('Turtleneck', 'uncommon', 5),
      labcoat: T('Lab coat', 'rare', 3), bomber: T('Bomber', 'rare', 3), tux: T('Tuxedo', 'legendary', 1),
    },
    chain: { none: T('None', 'common', 22, { none: true }), gold: T('Gold chain', 'uncommon', 8), silver: T('Silver chain', 'uncommon', 8), choker: T('Choker', 'rare', 4), diamond: T('Diamond chain', 'legendary', 1) },
    eyes: { none: T('None', 'common', 24, { none: true }), shades: T('Shades', 'uncommon', 6), monocle: T('Monocle', 'rare', 3) },
    hat: {
      none: T('None', 'common', 18, { none: true }), cap: T('Sports cap', 'common', 10), beanie: T('Beanie', 'common', 10), cowboy: T('Cowboy hat', 'uncommon', 7), hockey: T('Hockey helmet', 'uncommon', 6), army: T('Army helmet', 'uncommon', 6),
      crown: T('Crown', 'rare', 3), halo: T('Halo', 'legendary', 1),
    },
  };
  const ORDER = ['bg', 'skin', 'clothes', 'chain', 'eyes', 'hat'];
  const LABEL = { bg: 'Background', skin: 'Skin', clothes: 'Clothes', chain: 'Chain', hat: 'Hat', eyes: 'Eyes' };
  const DEFAULT = { bg: 'deep', skin: 'steel', clothes: 'none', chain: 'none', eyes: 'none', hat: 'none' };
  const BASE_PATH = (typeof root.SHARK_ASSETS === 'string') ? root.SHARK_ASSETS : 'assets/avatar/';

  /* ---------- backgrounds (procedural, drawn on the canvas at any size) ---------- */
  const BG = {
    deep: (x, s) => { fill(x, s, '#0B1F3F'); bubbles(x, s, '#1E3A6E'); },
    reef: (x, s) => { fill(x, s, '#0E5C6B'); waves(x, s, '#0A4753'); },
    base: (x, s) => { fill(x, s, '#0000FF'); grid(x, s, '#1A1AFF'); },
    mint: (x, s) => fill(x, s, '#CFF5E3'),
    sand: (x, s) => { fill(x, s, '#F1E3C2'); dots(x, s, '#E6D4AB'); },
    sunset: (x, s) => { const g = x.createLinearGradient(0, 0, 0, s); g.addColorStop(0, '#FF8A5B'); g.addColorStop(.55, '#FF5C7A'); g.addColorStop(1, '#4B2A7A'); x.fillStyle = g; x.fillRect(0, 0, s, s); x.fillStyle = '#FFD27A'; x.beginPath(); x.arc(s * .74, s * .29, s * .14, 0, 6.29); x.fill(); },
    lilac: (x, s) => fill(x, s, '#E3DAFF'),
    ink: (x, s) => { fill(x, s, '#0A0B0D'); grid(x, s, '#1C1E24'); },
    coral: (x, s) => fill(x, s, '#FFB6A8'),
    abyss: (x, s) => { const g = x.createRadialGradient(s * .5, s * .4, 0, s * .5, s * .4, s * .8); g.addColorStop(0, '#1B2E5C'); g.addColorStop(1, '#02050C'); x.fillStyle = g; x.fillRect(0, 0, s, s); bubbles(x, s, '#0E1B3A'); },
    aurora: (x, s) => { const g = x.createLinearGradient(0, s, s, 0); g.addColorStop(0, '#061A3A'); g.addColorStop(.45, '#0E7A6E'); g.addColorStop(.7, '#7BE0A8'); g.addColorStop(1, '#B78BFF'); x.fillStyle = g; x.fillRect(0, 0, s, s); },
  };
  function fill(x, s, c) { x.fillStyle = c; x.fillRect(0, 0, s, s); }
  function bubbles(x, s, c) { x.strokeStyle = c; x.lineWidth = s * .008; [[.12, .82, .018], [.21, .74, .01], [.18, .64, .008], [.86, .78, .022], [.92, .66, .012], [.89, .57, .008], [.29, .92, .012], [.08, .49, .01]].forEach(([px, py, r]) => { x.beginPath(); x.arc(px * s, py * s, r * s, 0, 6.29); x.stroke(); }); }
  function waves(x, s, c) { x.fillStyle = c; const a = s / 16; for (let y = s * .12; y < s; y += s / 8) { x.beginPath(); x.moveTo(0, y); for (let i = 0; i < 8; i++) x.quadraticCurveTo((i + .5) * s / 8, y - a * .7, (i + 1) * s / 8, y); x.lineTo(s, y + a * .45); for (let i = 8; i > 0; i--) x.quadraticCurveTo((i - .5) * s / 8, y + a * .45 - a * .7, (i - 1) * s / 8, y + a * .45); x.closePath(); x.fill(); } }
  function grid(x, s, c) { x.strokeStyle = c; x.lineWidth = Math.max(1, s * .004); for (let i = 0; i <= 16; i++) { const p = i * s / 16; x.beginPath(); x.moveTo(p, 0); x.lineTo(p, s); x.moveTo(0, p); x.lineTo(s, p); x.stroke(); } }
  function dots(x, s, c) { x.fillStyle = c; for (let r = 0; r < 13; r++) for (let q = 0; q < 13; q++) { x.beginPath(); x.arc((q + (r % 2 ? .5 : 0)) * s / 12.5 + s * .03, r * s / 12.5 + s * .03, s * .006, 0, 6.29); x.fill(); } }

  /* ---------- layer images (cached) ---------- */
  const IMG = {};
  function img(name, small) {
    const key = name + (small ? '_s' : '');
    if (IMG[key]) return IMG[key];
    IMG[key] = new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('avatar layer ' + key)); i.src = BASE_PATH + key + '.webp'; });
    return IMG[key];
  }
  function normalize(t) { const o = { ...DEFAULT }; if (t && typeof t === 'object') for (const k of ORDER) if (TRAITS[k][t[k]]) o[k] = t[k]; return o; }
  function layersOf(t) { const L = []; for (const k of ORDER) { if (k === 'bg') continue; const v = TRAITS[k][t[k]]; if (!v || v.none) continue; L.push(k + '_' + t[k]); } return L; }
  /* draw a full avatar into a canvas. size = canvas size in px; small uses the 256px thumbs; noBg leaves the background transparent */
  async function render(canvas, traits, opts = {}) {
    const t = normalize(traits); const s = opts.size || canvas.width || 512;
    if (canvas.width !== s) { canvas.width = s; canvas.height = s; }
    const x = canvas.getContext('2d'); x.clearRect(0, 0, s, s);
    if (!opts.noBg) BG[t.bg](x, s);
    const small = opts.small != null ? opts.small : s <= 256;
    const imgs = await Promise.all(layersOf(t).map((n) => img(n, small).catch(() => null)));
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    for (const i of imgs) if (i) x.drawImage(i, 0, 0, s, s);
    return canvas;
  }
  const URLS = {};
  /* data URL of a rendered avatar (cached per traits+size) */
  async function dataUrl(traits, size, opts = {}) {
    const t = normalize(traits); const key = JSON.stringify(t) + ':' + size + (opts.noBg ? ':nobg' : '');
    if (URLS[key]) return URLS[key];
    const c = document.createElement('canvas'); await render(c, t, { size, noBg: opts.noBg });
    URLS[key] = c.toDataURL('image/png'); return URLS[key];
  }
  /* PNG for download / minting: full 1024 with the background */
  async function exportPng(traits) { const c = document.createElement('canvas'); await render(c, traits, { size: SIZE, small: false }); return c.toDataURL('image/png'); }
  function randomTraits(rng = Math.random) { const t = {}; for (const k of ORDER) { const es = Object.entries(TRAITS[k]); const tot = es.reduce((a, [, v]) => a + v.w, 0); let r = rng() * tot; for (const [id, v] of es) { r -= v.w; if (r <= 0) { t[k] = id; break; } } if (!t[k]) t[k] = es[0][0]; } return t; }
  function pct(k, id) { const es = Object.values(TRAITS[k]); const tot = es.reduce((a, v) => a + v.w, 0); return Math.round(1000 * TRAITS[k][id].w / tot) / 10; }
  /* rarity score = Σ 1/p over traits (the intuition behind OpenRarity / rarity.tools): a 1%-trait adds 100, a 20%-trait adds 5 */
  function rarityScore(traits) { const t = normalize(traits); let s = 0; for (const k of ORDER) s += 100 / pct(k, t[k]); return Math.round(s); }
  // tiers calibrated on 20k weighted rolls: common ≈ bottom 60%, uncommon to ~p90, rare to ~p98, legendary = top 2%
  function rarityTier(score) { return score >= 130 ? 'legendary' : score >= 80 ? 'rare' : score >= 50 ? 'uncommon' : 'common'; }
  function attributes(traits) { const t = normalize(traits); return ORDER.map((k) => ({ trait_type: LABEL[k], value: TRAITS[k][t[k]].n, rarity: TRAITS[k][t[k]].r, pct: pct(k, t[k]) })); }
  function id(traits) { const t = normalize(traits); return ORDER.map((k) => t[k]).join('.'); }
  const api = { SIZE, TRAITS, ORDER, LABEL, RARITY, DEFAULT, normalize, layersOf, render, dataUrl, exportPng, randomTraits, pct, rarityScore, rarityTier, attributes, id, img };
  root.SHARK = api;
})(typeof window !== 'undefined' ? window : globalThis);
