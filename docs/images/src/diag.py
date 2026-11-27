"""
A small kit for the docs diagrams: boxes, lines, labels and icons drawn as SVG, in one look.

Each diagram is a short script in this folder (`python3 docs/images/src/<name>.py`) that writes
`docs/images/<name>.svg`. Text is real text, so the pictures stay sharp at any size and on any
screen, and a change is an edit to a script rather than a redraw.
"""

from __future__ import annotations

import math
import os
from html import escape

OUT = os.path.join(os.path.dirname(__file__), "..")

FONT = "Geist, Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"

BG = "#0b0d11"
CARD = "#151922"
EDGE = "#2c3240"
INK = "#f2f4f7"
TEXT = "#a9b1bf"
MUTED = "#6f7888"

TONES = {
    # name: (stroke, fill, line colour)
    "plain": (EDGE, CARD, "#6f7a90"),
    "blue": ("#4f7bff", "#121c38", "#5b85ff"),
    "orange": ("#ff7a45", "#2a1710", "#ff7a45"),
    "green": ("#3ccf8e", "#0f2a1f", "#3ccf8e"),
    "ghost": (EDGE, "#10131a", "#6f7a90"),
}


def text_width(s: str, size: float, weight: int = 500) -> float:
    """A close guess of how wide a line of sans-serif text is."""
    narrow = sum(1 for c in s if c in "iljtfr.,:;'!|() ")
    wide = sum(1 for c in s if c in "mwMWOQGD@%")
    caps = sum(1 for c in s if c.isupper())
    base = len(s) - narrow - wide
    w = (base * 0.56 + narrow * 0.32 + wide * 0.8 + caps * 0.08) * size
    return w * (1.04 if weight >= 600 else 1.0)


# The Bonded mark (as in apps/web/public/brand), on a 200 x 212 grid.
MARK = (
    "M7 0H130C159 0 182 23 182 51C182 75 170 90 149 101L112 121Q101 127 101 114V75Q101 49 73 61L7 90Q0 94 0 86V7Q0 0 7 0Z",
    "M0 130Q0 122 8 118L58 92Q77 82 77 101V137Q77 159 97 149L169 113Q175 110 180 117C193 129 200 143 200 158C200 190 172 212 136 212H6Q0 212 0 206Z",
)

# Line icons on a 24 x 24 grid, stroked.
ICONS = {
    "user": "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5",
    "users": "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.6 3-5.8 6.5-5.8s6.5 2.2 6.5 5.8M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.6c2.2.7 3.5 2.6 3.5 5.4",
    "server": "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
    "shield": "M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z",
    "shield-check": "M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6zM8.8 12l2.2 2.2 4.4-4.6",
    "vault": "M4 4h16v15H4zM12 15.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 9.5v2M7 19v2M17 19v2",
    "doc": "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6",
    "bell": "M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0",
    "card": "M3 6h18v12H3zM3 10h18M7 15h4",
    "wallet": "M4 7h15v12H4zM4 7V5.5A1.5 1.5 0 0 1 5.5 4H17M15 13h4",
    "terminal": "M4 5h16v14H4zM8 10l3 2.5L8 15M13 15h4",
    "chain": "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    "coins": "M12 9c4 0 7-1.3 7-3s-3-3-7-3-7 1.3-7 3 3 3 7 3zM5 6v6c0 1.7 3 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3 3 7 3s7-1.3 7-3v-6",
    "check": "M5 12.5l4.5 4.5L19 7.5",
    "x": "M6 6l12 12M18 6L6 18",
    "globe": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
    "cloud": "M7 18a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.6A3.8 3.8 0 0 1 17.5 18z",
    "lock": "M5 11h14v10H5zM8 11V8a4 4 0 0 1 8 0v3",
    "clock": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
    "chart": "M4 4v16h16M7 15l4-4 3 3 5-6",
    "chat": "M4 5h16v11H9l-5 4z",
    "news": "M4 5h13v14H6a2 2 0 0 1-2-2zM17 9h3v8a2 2 0 0 1-2 2M7 9h7M7 13h7M7 16h4",
    "swap": "M4 8h14l-3-3M20 16H6l3 3",
    "bolt": "M13 3L5 13.5h6L10 21l9-11h-6z",
    "flag": "M5 21V4M5 4h11l-2 4 2 4H5",
    "target": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01",
    "book": "M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2zM4 20a2 2 0 0 0 2 2h13v-4",
    "key": "M8 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM11 11h10M18 11v3M15 11v2",
    "scale": "M12 4v16M5 20h14M6 8h12M6 8l-3 6a3 3 0 0 0 6 0zM18 8l-3 6a3 3 0 0 0 6 0z",
    "eye": "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "hash": "M5 9h15M4 15h15M10 3L8 21M16 3l-2 18",
    "play": "M7 4.5v15L19.5 12z",
    "upload": "M12 16V4M7 9l5-5 5 5M4 17v3h16v-3",
    "search": "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
    "cpu": "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
    "snow": "M12 2v20M4.5 6.5l15 11M19.5 6.5l-15 11",
    "arrow-up": "M12 20V5M6 11l6-6 6 6",
    "refresh": "M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4",
    "plug": "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
    "pulse": "M3 12h4l2-5 4 10 2-5h6",
}


class Diagram:
    def __init__(self, name: str, width: int, height: int, label: str):
        self.name = name
        self.w = width
        self.h = height
        self.label = label
        self.base: list[str] = []  # panels that group boxes, drawn first
        self.back: list[str] = []  # lines, drawn under the boxes
        self.body: list[str] = []
        self.front: list[str] = []  # pills on lines, drawn last
        self.markers: set[str] = set()

    # ---------- primitives ----------
    def text(self, x, y, s, size=20, weight=500, color=INK, anchor="middle", mono=False, layer=None):
        fam = MONO if mono else FONT
        (layer if layer is not None else self.body).append(
            f'<text x="{x:.1f}" y="{y:.1f}" font-family="{fam}" font-size="{size}" '
            f'font-weight="{weight}" fill="{color}" text-anchor="{anchor}" '
            f'dominant-baseline="central">{escape(s)}</text>'
        )

    def mark(self, x, y, size=24, color="#4f7bff", layer=None):
        """The Bonded mark, filled, centred on (x, y): used wherever a box means Bonded itself."""
        s = size / 212
        (layer if layer is not None else self.body).append(
            f'<g transform="translate({x - 100 * s:.1f} {y - 106 * s:.1f}) scale({s:.4f})" fill="{color}">'
            f'<path d="{MARK[0]}"/><path d="{MARK[1]}"/></g>'
        )

    def icon(self, name, x, y, size=24, color=INK, width=1.8, layer=None):
        """An icon centred on (x, y). "bonded" is the Bonded mark rather than a line icon."""
        if name == "bonded":
            self.mark(x, y, size * 0.82, color, layer)
            return
        s = size / 24
        (layer if layer is not None else self.body).append(
            f'<path d="{ICONS[name]}" transform="translate({x - size / 2:.1f} {y - size / 2:.1f}) scale({s:.3f})" '
            f'fill="none" stroke="{color}" stroke-width="{width / s:.2f}" stroke-linecap="round" stroke-linejoin="round"/>'
        )

    def panel(self, x, y, w, h, title=None, sub=None, radius=18, tone="ghost", dashed=False, mark=False):
        """A quiet area that groups boxes, with an optional heading in its top-left corner."""
        stroke, fill, _ = TONES[tone]
        dash = ' stroke-dasharray="6 6"' if dashed else ""
        self.base.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="1.2"{dash}/>'
        )
        if title:
            tx = x + 24
            if mark:
                self.mark(x + 34, y + 36, 20, "#4f7bff", layer=self.base)
                tx = x + 54
            self.text(tx, y + 36, title, 22, 650, anchor="start", layer=self.base)
        if sub:
            self.text(x + 24, y + 64, sub, 16, 400, TEXT, anchor="start", layer=self.base)

    def box(self, x, y, w, h, tone="plain", dashed=False, radius=14, glow=False):
        stroke, fill, _ = TONES[tone]
        if glow:
            self.body.append(
                f'<rect x="{x - 6}" y="{y - 6}" width="{w + 12}" height="{h + 12}" rx="{radius + 6}" '
                f'fill="{stroke}" opacity="0.16" filter="url(#blur)"/>'
            )
        dash = ' stroke-dasharray="6 6"' if dashed else ""
        self.body.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="1.5"{dash}/>'
        )

    def node(self, x, y, w, h, title, sub=None, tone="plain", icon=None, dashed=False, glow=False,
             size=20, sub_size=15, align="left"):
        """A box with an optional icon tile, a title and a grey line under it."""
        self.box(x, y, w, h, tone, dashed, glow=glow)
        stroke = TONES[tone][0]
        cy = y + h / 2
        if align == "center":
            ty = cy - (11 if sub else 0)
            if icon:
                self.icon(icon, x + w / 2, y + 30, 26, stroke if tone != "plain" else INK)
                ty = y + 66 if not sub else y + 62
            self.text(x + w / 2, ty, title, size, 600)
            if sub:
                self.text(x + w / 2, ty + size + 4, sub, sub_size, 400, TEXT)
            return
        tx = x + 20
        if icon:
            self.body.append(
                f'<rect x="{x + 16}" y="{cy - 20}" width="40" height="40" rx="10" fill="#0b0d11" '
                f'stroke="{EDGE}" stroke-width="1"/>'
            )
            self.icon(icon, x + 36, cy, 22, stroke if tone != "plain" else INK)
            tx = x + 70
        if sub:
            self.text(tx, cy - 11, title, size, 600, anchor="start")
            self.text(tx, cy + 13, sub, sub_size, 400, TEXT, anchor="start")
        else:
            self.text(tx, cy, title, size, 600, anchor="start")

    def chip(self, x, y, s, tone="plain", size=15, layer="front", fill=BG, anchor="middle"):
        """A small rounded label, centred on (x, y) (or starting at x with anchor="start")."""
        stroke, _, line = TONES[tone]
        w = text_width(s, size) + 26
        h = size + 15
        left = x - w / 2 if anchor == "middle" else x
        color = {"plain": "#cdd3de", "ghost": "#cdd3de"}.get(tone, "#ffffff")
        edge = line if tone != "plain" else "#3a4150"
        target = self.front if layer == "front" else self.body
        target.append(
            f'<rect x="{left:.1f}" y="{y - h / 2:.1f}" width="{w:.1f}" height="{h}" rx="{h / 2}" '
            f'fill="{fill}" stroke="{edge}" stroke-width="1.2"/>'
        )
        self.text(left + w / 2, y + 0.5, s, size, 500, color, layer=target)
        return w

    def line(self, pts, tone="plain", dashed=False, arrow=True, width=2, radius=12, start_arrow=False):
        """A line through the points, with rounded corners and an arrowhead at the end."""
        color = TONES[tone][2]
        d = rounded(pts, radius)
        marker = f"a-{tone}"
        self.markers.add(tone)
        dash = ' stroke-dasharray="7 6"' if dashed else ""
        end = f' marker-end="url(#{marker})"' if arrow else ""
        beg = f' marker-start="url(#{marker}s)"' if start_arrow else ""
        self.back.append(
            f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" '
            f'stroke-linecap="round" stroke-linejoin="round"{dash}{end}{beg}/>'
        )

    def diamond(self, cx, cy, w, h, s, tone="plain", size=18):
        stroke, fill, _ = TONES[tone]
        self.body.append(
            f'<path d="M{cx} {cy - h / 2}L{cx + w / 2} {cy}L{cx} {cy + h / 2}L{cx - w / 2} {cy}Z" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="1.5" stroke-linejoin="round"/>'
        )
        self.text(cx, cy, s, size, 500)

    def badge(self, x, y, n, tone="blue", r=15):
        stroke = TONES[tone][0]
        self.body.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{stroke}"/>')
        self.text(x, y + 0.5, str(n), 15, 700, "#ffffff")

    def raw(self, svg, layer=None):
        (layer if layer is not None else self.body).append(svg)

    # ---------- output ----------
    def svg(self) -> str:
        markers = []
        for tone in sorted(self.markers):
            c = TONES[tone][2]
            markers.append(
                f'<marker id="a-{tone}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="9" '
                f'markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">'
                f'<path d="M0 0L10 5L0 10z" fill="{c}"/></marker>'
                f'<marker id="a-{tone}s" viewBox="0 0 10 10" refX="1.5" refY="5" markerWidth="9" '
                f'markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">'
                f'<path d="M10 0L0 5L10 10z" fill="{c}"/></marker>'
            )
        head = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" '
            f'width="{self.w}" height="{self.h}" role="img" aria-label="{escape(self.label)}">'
            f'<defs>{"".join(markers)}'
            f'<filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>'
            f'<radialGradient id="bg" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#101626"/>'
            f'<stop offset="1" stop-color="{BG}"/></radialGradient></defs>'
            f'<rect width="{self.w}" height="{self.h}" rx="20" fill="url(#bg)"/>'
        )
        return head + "".join(self.base + self.back + self.body + self.front) + "</svg>\n"

    def save(self):
        path = os.path.normpath(os.path.join(OUT, f"{self.name}.svg"))
        with open(path, "w") as f:
            f.write(self.svg())
        print(path)


def rounded(pts, r):
    """An SVG path through points, each corner rounded by up to r."""
    if len(pts) < 3 or r <= 0:
        return "M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in pts)
    d = f"M{pts[0][0]:.1f} {pts[0][1]:.1f}"
    for i in range(1, len(pts) - 1):
        (x0, y0), (x1, y1), (x2, y2) = pts[i - 1], pts[i], pts[i + 1]
        l1 = math.hypot(x1 - x0, y1 - y0)
        l2 = math.hypot(x2 - x1, y2 - y1)
        k = min(r, l1 / 2, l2 / 2)
        if k <= 0.01:
            d += f"L{x1:.1f} {y1:.1f}"
            continue
        ax, ay = x1 - (x1 - x0) / l1 * k, y1 - (y1 - y0) / l1 * k
        bx, by = x1 + (x2 - x1) / l2 * k, y1 + (y2 - y1) / l2 * k
        d += f"L{ax:.1f} {ay:.1f}Q{x1:.1f} {y1:.1f} {bx:.1f} {by:.1f}"
    d += f"L{pts[-1][0]:.1f} {pts[-1][1]:.1f}"
    return d
