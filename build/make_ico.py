"""Packages favicon.ico (multi-resolution) from the rendered 256px PNG.
Usage: python build/make_ico.py   (run from the project root)
"""
import os
from PIL import Image

BASE = "build/_favicon-256.png"
OUT = "favicon.ico"
SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

img = Image.open(BASE).convert("RGBA")
img.save(OUT, format="ICO", sizes=SIZES)
print(f"Wrote {OUT} with sizes {', '.join(f'{w}x{h}' for w, h in SIZES)}")

# tidy up the temporary base image
try:
    os.remove(BASE)
except OSError:
    pass
