from diag import Diagram
from _shared import alt

d = Diagram("byoa-how-a-test-works", 1000, 470, alt("docs/BRING-YOUR-OWN-AGENT.md", "byoa-how-a-test-works"))

d.panel(24, 24, 212, 422, "Your side")
d.panel(252, 24, 512, 422, "Bonded sandbox", mark=True)
d.panel(780, 24, 196, 422, "Your report")

# The agent
d.box(52, 170, 156, 116, "blue", glow=True)
d.icon("terminal", 130, 210, 34, "#4f7bff")
d.text(130, 258, "Your agent", 19, 600)

# What it reads
sources = [("News", "news", "plain"), ("Chat", "chat", "plain"), ("Price chart", "chart", "plain"),
           ("Document", "doc", "plain"), ("Planted alert", "bell", "orange")]
BUS = 238
ys = [122 + i * 62 for i in range(len(sources))]
for (name, icon, tone), y in zip(sources, ys):
    d.node(282, y - 23, 196, 46, name, tone=tone, icon=None, size=17)
    d.icon(icon, 456, y, 20, "#ff7a45" if tone == "orange" else "#a9b1bf")
    d.line([(282, y), (BUS, y)], tone, arrow=False)
d.line([(BUS, ys[0]), (BUS, ys[-1])], "plain", arrow=False)
d.line([(BUS, 228), (210, 228)], "blue")
d.chip(BUS, 339, "reads", "plain", layer="front")

# What it does goes through the rules
d.node(530, 196, 210, 74, "Rules", "checked by code", tone="blue", icon="shield-check")
d.line([(130, 288), (130, 420), (635, 420), (635, 272)], "blue", radius=16)
d.chip(400, 420, "everything it does", "blue")

# The result
d.line([(742, 233), (806, 233)], "blue")
d.node(808, 196, 144, 74, "Report", "the result", icon="doc", size=18, sub_size=14)
d.save()
