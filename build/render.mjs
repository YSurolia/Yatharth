// Renders the SVG sources into all the raster assets the site needs.
// Usage: node build/render.mjs   (run from the project root)
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const FONT_FILES = [
  'build/fonts/space-grotesk-400.ttf',
  'build/fonts/space-grotesk-500.ttf',
  'build/fonts/space-grotesk-700.ttf',
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/segoeuib.ttf',
].map((p) => resolve(p))

function render(svgPath, outPath, width) {
  const svg = readFileSync(resolve(svgPath))
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles: FONT_FILES, loadSystemFonts: true, defaultFontFamily: 'Space Grotesk' },
    shapeRendering: 2,
    textRendering: 2,
  })
  const png = resvg.render().asPng()
  mkdirSync(dirname(resolve(outPath)), { recursive: true })
  writeFileSync(resolve(outPath), png)
  console.log(`  ${outPath}  (${width}px wide)`)
}

console.log('Rendering favicons from favicon.svg ...')
render('favicon.svg', 'favicon-16x16.png', 16)
render('favicon.svg', 'favicon-32x32.png', 32)
render('favicon.svg', 'favicon-96x96.png', 96)
render('favicon.svg', 'build/_favicon-256.png', 256) // base for favicon.ico

console.log('Rendering app icons from assets/apple-icon.svg ...')
render('assets/apple-icon.svg', 'apple-touch-icon.png', 180)
render('assets/apple-icon.svg', 'icon-192.png', 192)
render('assets/apple-icon.svg', 'icon-512.png', 512)

console.log('Rendering social share image from assets/og-image.svg ...')
render('assets/og-image.svg', 'og-image.png', 1200)

console.log('Done. Now run: python build/make_ico.py')
