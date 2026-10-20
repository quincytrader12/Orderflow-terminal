"""Build every app icon from the emblem (src/assets/emblem.png).

  python3 scripts/make-icons.py      (needs Pillow)

build/icon.png      1024 px, black rounded plate (macOS/Linux, window icon)
build/icon.ico      16-256 px multi-size Windows icon
public/favicon.png  browser tab, public/apple-touch-icon.png
src/assets/logo-96.png  transparent top-bar logo
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
EMBLEM = Image.open(ROOT / 'src/assets/emblem.png').convert('RGBA')


def icon(size, bg=True, scale=0.84, radius=0.2, boost=1.0):
    s = size * 4  # supersample, then downscale for clean edges
    canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    if bg:
        mask = Image.new('L', (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * radius), fill=255)
        canvas.paste(Image.new('RGBA', (s, s), (0, 0, 0, 255)), (0, 0), mask)
    e = EMBLEM.resize((int(s * scale), int(s * scale)), Image.LANCZOS)
    if boost != 1.0:
        e = ImageEnhance.Brightness(e).enhance(boost)
    off = (s - e.width) // 2
    canvas.alpha_composite(e, (off, off))
    out = canvas.resize((size, size), Image.LANCZOS)
    if size <= 48:
        out = out.filter(ImageFilter.UnsharpMask(radius=0.6, percent=120, threshold=0))
    return out


icon(1024).save(ROOT / 'build/icon.png')
sizes = [16, 24, 32, 48, 64, 128, 256]
# small sizes get a slightly larger, brighter emblem so the thin arms stay visible
imgs = [icon(n, scale=0.92 if n <= 32 else 0.86, boost=1.15 if n <= 32 else 1.0) for n in sizes]
imgs[-1].save(ROOT / 'build/icon.ico', sizes=[(n, n) for n in sizes], append_images=imgs[:-1])
(ROOT / 'public').mkdir(exist_ok=True)
icon(64, scale=0.9, boost=1.1).save(ROOT / 'public/favicon.png')
icon(180, scale=0.8, radius=0.22).save(ROOT / 'public/apple-touch-icon.png')
icon(96, bg=False, scale=1.0).save(ROOT / 'src/assets/logo-96.png')
print('icons written')
