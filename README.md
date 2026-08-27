# Basefish 🐟

Top 100 holders of Base ecosystem tokens, visualised as a living aquarium.
Community project — not affiliated with Base, Coinbase, or any token team.

## How it works
- `scripts/fetch.mjs` pulls top holders, prices and recent transfers from Moralis (every ~2h via GitHub Actions) and writes static JSON into `data/`.
- `index.html` is the whole frontend (Canvas 2D, no build step). It loads `data/index.json`; if missing it runs in demo mode with simulated data.
- Deployed on Netlify from this repo — every data refresh commit redeploys the site.

## Config
Token list lives in `tokens.config.json` (contract, color, per-token excluded addresses).
Secret required in Actions: `MORALIS_API_KEY`.
