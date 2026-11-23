#!/usr/bin/env python3
"""Renders the frames of the board's "needs you" mark as static PNGs.

Orca's components panels accept only still png/jpg/webp images (animated images are refused), so
the panel cycles these frames itself to make a pulsing dot. The "running" mark is Orca's built-in
Spinner and needs no asset.

Run from the repository root: python3 scripts/make-lane-marks.py  (needs Pillow)
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "plugin" / "coordinator-board" / "assets"
SIZE = 48          # final pixels
SCALE = 4          # draw large, then downsample for smooth edges
RED = (239, 68, 68)
FRAMES = 3         # keep in step with NEEDS_YOU_FRAMES in src/panel.tsx


def frame(t):
    """t in [0, 1): the ring grows from the dot and fades out."""
    big = SIZE * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = big / 2
    dot = big * 0.17
    ring = dot + (big * 0.44 - dot) * (0.25 + 0.75 * t)
    alpha = int(220 * (1 - t) + 35)
    w = int(big * 0.07)
    d.ellipse([c - ring, c - ring, c + ring, c + ring], outline=RED + (alpha,), width=w)
    d.ellipse([c - dot, c - dot, c + dot, c + dot], fill=RED + (255,))
    return img.resize((SIZE, SIZE), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.webp"):
        old.unlink()
    for i in range(FRAMES):
        path = OUT / f"needs-you-{i}.png"
        frame(i / FRAMES).save(path, optimize=True)
        print(f"{path.name}: {path.stat().st_size} bytes")
