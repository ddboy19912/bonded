from diag import Diagram, TEXT
from _shared import alt

d = Diagram("byoa-inside-an-episode", 1000, 600, alt("docs/CONNECTING-YOUR-AGENT.md", "byoa-inside-an-episode"))

sources = [
    ("Inbox", "doc", "plain"), ("News", "news", "plain"), ("Social", "chat", "orange"),
    ("Prices", "chart", "plain"), ("Token info", "target", "plain"), ("Transfers", "swap", "plain"),
    ("Research report", "book", "plain"), ("Market alerts", "bell", "orange"), ("Agent messages", "users", "plain"),
]
d.panel(24, 24, 222, 552, "Nine sources")
BUS, AY = 266, 300
ys = [104 + i * 52 for i in range(len(sources))]
for (name, icon, tone), y in zip(sources, ys):
    stroke = "#ff7a45" if tone == "orange" else "#a9b1bf"
    d.icon(icon, 58, y, 20, stroke)
    d.text(80, y, name, 17, 500, "#ff9a70" if tone == "orange" else "#e6e9ef", anchor="start")
    d.line([(222, y), (BUS, y)], tone, arrow=False)
d.line([(BUS, ys[0]), (BUS, ys[-1])], "plain", arrow=False)
d.line([(BUS, AY), (296, AY)], "blue")

# The agent, with its time limit
d.box(298, 236, 132, 128, "blue", glow=True)
d.icon("terminal", 364, 284, 38, "#4f7bff")
d.text(364, 330, "Your agent", 17, 600)
d.chip(364, 200, "90 s time limit", "plain", size=15)

# What it does
acts = ["swap", "transfer", "approve"]
AX, AW = 486, 138
for i, a in enumerate(acts):
    y = 220 + i * 80
    d.node(AX, y - 24, AW, 48, a, align="center", size=18)
    d.line([(432, AY), (458, AY), (458, y), (AX - 2, y)], "blue", radius=10)
    d.line([(AX + AW, y), (650, y), (650, AY), (676, AY)], "blue", radius=10)

# The mandate check decides
d.box(678, 236, 132, 128, "blue")
d.icon("vault", 744, 282, 38, "#4f7bff")
d.text(744, 330, "Mandate check", 16, 600)

d.line([(812, AY), (836, AY), (836, 230), (858, 230)], "blue", radius=10)
d.line([(812, AY), (836, AY), (836, 370), (858, 370)], "orange", radius=10)
d.node(860, 202, 116, 56, "Allowed", tone="blue", align="center", size=17)
d.node(860, 334, 116, 72, "Breach", "recorded", tone="orange", align="center", size=17, sub_size=14)

# Key
d.raw('<circle cx="296" cy="556" r="5" fill="#ff7a45"/>')
d.text(310, 556, "planted in this example", 15, 400, TEXT, anchor="start")
d.save()
