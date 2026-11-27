from diag import Diagram, TEXT, TONES

d = Diagram(
    "architecture-payment-gate", 1100, 640,
    "The agent's server asks the gate first and the card program calls it from a card hook; the "
    "gate answers allowed or blocked with a signed receipt. Wallets and your payment log are "
    "watched after the fact. The gate sends alerts and anchors a daily log root in GateAnchor on "
    "Robinhood Chain.",
)

# Left: what decides before the money moves, and what is checked after.
d.panel(20, 20, 330, 290, "Decides first", "before the money moves")
d.panel(20, 330, 330, 290, "Watches after", "after the fact", dashed=True)
d.node(44, 110, 282, 72, "Agent's server", icon="server")
d.node(44, 210, 282, 72, "Card program", icon="card")
d.node(44, 420, 282, 72, "Wallets", icon="wallet", dashed=True)
d.node(44, 520, 282, 72, "Your payment log", icon="doc", dashed=True)

# Centre: the gate.
GX, GY, GW, GH = 470, 220, 220, 180
d.box(GX, GY, GW, GH, "blue", glow=True)
d.icon("shield-check", GX + GW / 2, GY + 38, 30, TONES["blue"][0])
d.text(GX + GW / 2, GY + 82, "Gate rules", 21, 650)
d.text(GX + GW / 2, GY + 116, "allowed or blocked,", 15, 400, TEXT)
d.text(GX + GW / 2, GY + 138, "with a signed receipt", 15, 400, TEXT)

# Before: ask first, card hook (both get an answer back).
d.line([(328, 146), (580, 146), (580, GY - 2)], "blue", start_arrow=True, radius=16)
d.chip(450, 146, "ask first", "blue")
d.line([(328, 246), (GX - 2, 246)], "blue", start_arrow=True)
d.chip(400, 246, "card hook", "blue")

# After: watched, decides nothing in time.
d.line([(328, 456), (430, 456), (430, 370), (GX - 2, 370)], "plain", dashed=True, radius=16)
d.line([(328, 556), (580, 556), (580, GY + GH + 2)], "plain", dashed=True, radius=16)
d.chip(450, 556, "watch")

# Right: what the gate sends out.
d.node(860, 60, 216, 72, "Alerts", icon="bell")
d.node(860, 265, 216, 90, "GateAnchor", "Robinhood Chain", icon="chain", tone="blue")
d.line([(640, GY - 2), (640, 96), (858, 96)], "blue", radius=16)
d.line([(GX + GW + 2, 310), (858, 310)], "blue")
d.chip(775, 310, "daily log root", "blue")
d.save()
