#!/usr/bin/env python3
"""Generate TongRadio Assistant extension icons.

Primary source: the radio site's PWA icon (../TongRadio/site/icon-512.png),
so the extension branding matches the radio site. Falls back to a generated
purple + white-EQ-bars icon if the source is missing.
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "icons")
SOURCE = os.path.normpath(os.path.join(ROOT, "..", "TongRadio", "site", "icon-512.png"))

BG = (108, 97, 200, 255)   # #6C61C8 TongRadio primary
BAR = (255, 255, 255, 255)


def fallback_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=max(1, int(size * 0.22)), fill=BG)
    heights = [0.30, 0.55, 0.85, 0.55, 0.35]
    gap = size * 0.09
    bar_w = max(1.0, (size - 2 * gap - (n - 1) * gap * 0.6) / (n := 5))
    total_w = n * bar_w + (n - 1) * gap * 0.6
    x0 = (size - total_w) / 2.0
    bottom = size * 0.78
    for i, h in enumerate(heights):
        hpx = bottom - size * h
        x = x0 + i * (bar_w + gap * 0.6)
        d.rectangle([x, hpx, x + bar_w, bottom], fill=BAR)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    src = None
    if os.path.isfile(SOURCE):
        try:
            src = Image.open(SOURCE).convert("RGBA")
            print(f"using radio site icon: {SOURCE}")
        except Exception as e:
            print(f"failed to load radio icon ({e}); using fallback")
            src = None

    for size in (16, 32, 48, 128):
        img = src.resize((size, size), Image.LANCZOS) if src else fallback_icon(size)
        img.save(os.path.join(OUT, f"icon-{size}.png"))
        print(f"icon-{size}.png ok ({'radio' if src else 'fallback'})")


if __name__ == "__main__":
    main()
