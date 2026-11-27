from diag import Diagram
from _shared import alt

d = Diagram("bounties-decision", 1000, 770, alt("docs/BOUNTIES-EXPLAINED.md", "bounties-decision"))

CX, DW, DH = 270, 460, 96       # the column of questions
RX, RW, RH = 610, 360, 64       # the outcomes on the right


def outcome(y, text, tone):
    d.node(RX, y - RH / 2, RW, RH, text, tone=tone, icon="check" if tone == "blue" else "x", size=19)


d.node(CX - 110, 28, 220, 56, "Attack sent", tone="blue", align="center")
d.line([(CX, 84), (CX, 140)], "blue")

qs = [
    (190, "Already in the library?", "yes", "Rejected: duplicate", "orange", "no"),
    (340, "Fools the undefended agent 2 of 3 times?", "no", "Rejected: not reproducible", "orange", "yes"),
    (490, "Fools the defended agent 2 of 3 times?", "yes", "Accepted: 2,000 tUSDG", "blue", "no"),
]
for i, (y, q, side, out, tone, down) in enumerate(qs):
    d.diamond(CX, y, DW, DH, q, size=17)
    d.line([(CX + DW / 2, y), (RX - 4, y)], tone)
    d.chip((CX + DW / 2 + RX) / 2, y, side, tone)
    outcome(y, out, tone)
    nxt = qs[i + 1][0] if i + 1 < len(qs) else 650
    d.line([(CX, y + DH / 2), (CX, nxt - DH / 2 - 2)], "blue")
    d.chip(CX - 40, (y + DH / 2 + nxt - DH / 2) / 2, down, "plain")

y, split = 650, 556
d.diamond(CX, y, DW, DH, "A new attack type on a new surface?", size=17)
d.line([(CX + DW / 2, y), (split, y)], "plain", arrow=False)
for dy, side, out, tone in [(-58, "yes", "Accepted: 500 tUSDG", "blue"), (58, "no", "Rejected: already known", "orange")]:
    d.line([(split, y), (split, y + dy), (RX - 4, y + dy)], tone, radius=12)
    d.chip(split, y + dy / 2, side, tone)
    outcome(y + dy, out, tone)
d.save()
