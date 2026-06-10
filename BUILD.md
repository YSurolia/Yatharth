# Brand assets — logo, favicons & social share image

Sources and build tooling for the yatharth.org logo, favicons and the social
share (Open Graph) image. The generated files are committed too, so you only need
this if you want to change the look.

## Edit these (vector sources)

| File | What it controls |
|---|---|
| `favicon.svg` | The browser-tab "Y" mark |
| `assets/logo.svg` / `assets/logo-white.svg` | Full logo lockup (mark + wordmark), light / dark |
| `assets/logo-mark.svg` | Standalone "Y" mark |
| `assets/apple-icon.svg` | Full-bleed icon (iOS / PWA) |
| `assets/og-image.svg` | 1200×630 share image — edit the **name, tagline and domain** here |

## Regenerate the images

```bash
npm install      # installs @resvg/resvg-js (first time only)
npm run build    # renders all PNGs, then packs favicon.ico
```

`npm run build` writes: `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`,
`favicon-96x96.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, and
`og-image.png`. (`favicon.ico` packing needs Python 3 with `pip install pillow`.)

## Brand

- Accent: electric blue `#2242ff` → `#5C7BFF`
- Background: near-black `#050505`, tile `#141A33` → `#070A16`
- Text on dark: `#F5EEE9`
- Font: **Space Grotesk** (OFL — license in `build/fonts/OFL.txt`)

> After deploying a new `og-image.png`, re-scrape the preview at
> https://www.opengraph.xyz so social platforms drop the cached old image.
