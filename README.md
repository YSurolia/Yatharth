# yatharth.org — brand asset source kit

Editable **source files** for the yatharth.org logo, favicons and social share image.
The finished assets have already been added to your site repo
(**github.com/YSurolia/Yatharth**) and are live at **https://www.yatharth.org/**.

This folder is just the workshop — keep it if you ever want to tweak the look and
regenerate the images.

## What's here

| File | What it is |
|---|---|
| `assets/logo.svg` / `assets/logo-white.svg` | Full logo lockup (Y mark + "yatharth.org") for light / dark backgrounds |
| `assets/logo-mark.svg` | The standalone "Y" icon |
| `assets/apple-icon.svg` | Full-bleed icon source (for the iOS / PWA icons) |
| `assets/og-image.svg` | Source for the 1200×630 social share image |
| `favicon.svg` | The browser-tab mark (also the favicon source) |
| `favicon.ico`, `favicon-16/32/96.png` | Generated browser favicons |
| `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` | Generated app / PWA icons |
| `og-image.png` | Generated social share image |
| `site.webmanifest` | PWA manifest |
| `build/` | Render scripts + the Space Grotesk fonts used |

## Brand

| | |
|---|---|
| Accent | electric blue `#2242ff` → `#5C7BFF` |
| Background | near-black `#050505` / tile `#141A33`→`#070A16` |
| Text on dark | `#F5EEE9` (warm off-white) |
| Font | Space Grotesk (matches the site) |

## Tweak & regenerate

1. Edit the relevant SVG in `assets/` (or `favicon.svg`). To change the share-image
   text — name, tagline, domain — edit `assets/og-image.svg`.
2. Rebuild the PNG/ICO files:
   ```bash
   npm install      # first time only
   npm run build    # renders all PNGs, then packs favicon.ico (needs Python + Pillow)
   ```

## Re-deploy to the live site

The site is hosted from your GitHub repo, so copy the regenerated files in and push:

```bash
git clone https://github.com/YSurolia/Yatharth.git
# copy favicon.*, *.png, og-image.png, site.webmanifest and assets/ into the clone
git -C Yatharth add -A && git -C Yatharth commit -m "Update brand assets" && git -C Yatharth push
```

> Tip: after deploying a new `og-image.png`, paste your URL into
> https://www.opengraph.xyz or Facebook's Sharing Debugger and click "scrape again"
> to refresh the cached preview on social platforms.
