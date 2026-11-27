"""Helpers shared by the step-row diagrams and a reader for each picture's alt text."""

import os
import re

from diag import BG, INK, TEXT, TONES

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def alt(md: str, name: str) -> str:
    """The alt text the Markdown gives this picture, so the SVG's label always matches it."""
    with open(os.path.join(ROOT, md)) as f:
        m = re.search(r"!\[([^\]]+)\]\([^)]*" + re.escape(name) + r"\.(?:webp|svg)\)", f.read())
    if not m:
        raise SystemExit(f"no alt text for {name} in {md}")
    return m.group(1)


def steps(d, items, y, x0, x1, r=42, last_tone="blue"):
    """A row of round steps joined by arrows: (icon, title, [sub lines], tone)."""
    n = len(items)
    gap = (x1 - x0) / (n - 1)
    for i, (icon, title, subs, tone) in enumerate(items):
        cx = x0 + i * gap
        stroke, fill, _ = TONES[tone]
        if i < n - 1:
            d.line([(cx + r + 8, y), (cx + gap - r - 10, y)], "blue")
        if tone != "plain":
            d.raw(f'<circle cx="{cx}" cy="{y}" r="{r + 8}" fill="{stroke}" opacity="0.18" filter="url(#blur)"/>')
        d.raw(f'<circle cx="{cx}" cy="{y}" r="{r}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        d.icon(icon, cx, y, 30, stroke if tone != "plain" else INK)
        d.text(cx, y + r + 34, title, 19, 600)
        for j, s in enumerate(subs):
            d.text(cx, y + r + 60 + j * 20, s, 15, 400, TEXT)
