# REEF — landing page

Static site. No build step, no dependencies, nothing to install.

## Deploy
Upload the contents of this folder to any static host — Netlify, Vercel, Cloudflare Pages,
GitHub Pages, S3, plain nginx. `index.html` must sit at the web root; keep `assets/` beside it.

Netlify: drag this folder onto the deploy area, or `netlify deploy --prod --dir=.`

## What's inside
    index.html          the whole page: markup, styles and the aquarium engine
    assets/fonts/       Inter Tight (400/500/600) and Roboto Mono (400/500), self-hosted
    assets/tank/        fish and scenery sprites used by the canvas
    assets/favicon.svg  favicon
    assets/reef-og.png  Open Graph preview image
    _headers            security headers + long cache for assets (Netlify syntax)
    robots.txt

## Where it runs
`usereef.io` — its own Netlify site, base directory `landing/`, no build command.
The app is a separate site on `app.usereef.io`, served from the repo root.

The waitlist form POSTs to `https://app.usereef.io/api/waitlist` (email + Base wallet, deduped on both,
five sign-ups per connection per hour). That function allows this origin by name; if the landing ever moves
to another domain, add it to `ALLOW` in `netlify/functions/waitlist.mjs`.

The tracked-token figure in the stats grid is fetched from the app's `data/index.json` at load, with the
number in the markup as the fallback — so it cannot go stale.

## Still open
1. The footer's Privacy / Cookie / Terms links point at `#`. We collect email addresses, so a privacy
   policy needs to exist before this goes live.
2. The nav button always reads "Connect wallet"; it could read "Open app" for a returning visitor.
3. The tank's holder figures ($AERO, 8.03%, "snapshot 08:17 UTC") are hardcoded sample data.

## Notes
- Sprites are loaded as normal image files; if any fail, the aquarium falls back to vector fish.
- Below 900px, and for visitors with "reduce motion" on, the scroll choreography is disabled
  and the page renders as a plain stack.
