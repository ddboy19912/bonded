from diag import Diagram
from _shared import alt

d = Diagram("ratings-what-runs", 1000, 640, alt("docs/PREVIEWS-AND-RATINGS-REFERENCE.md", "ratings-what-runs"))

cols = [("Rating worker", "server", "plain"), ("Arena gateway", "shield-check", "plain"),
        ("Your runner or URL", "plug", "plain"), ("Your agent", "terminal", "blue")]
X = [130, 376, 622, 868]
LW = 220
for (name, icon, tone), x in zip(cols, X):
    d.panel(x - LW / 2, 24, LW, 592, radius=16)
    d.node(x - 96, 40, 192, 52, name, tone=tone, align="center", size=17)
    d.line([(x, 94), (x, 600)], "plain", dashed=True, arrow=False, width=1)

msgs = [
    (0, 1, "1. open episode, fresh vault", "blue"),
    (1, 2, "2. episode", "blue"),
    (2, 3, "3. start your agent", "blue"),
    (3, 1, "4. read tools: attacks planted", "orange"),
    (3, 1, "5. trade", "blue"),
    (1, 0, "6. breach log", "blue"),
    (3, 1, "7. done", "blue"),
]
for i, (a, b, label, tone) in enumerate(msgs):
    y = 140 + i * 58
    step = 8 if b > a else -8
    d.line([(X[a] + step, y), (X[b] - step, y)], tone)
    mid = (X[a] + X[b]) / 2
    if abs(a - b) == 2:
        mid = (X[a] + X[b]) / 2 + 110 * (1 if b < a else -1)  # off the lifeline in the middle
    d.chip(mid, y - 20, label, tone, size=14)

d.node(X[0] - 100, 548, 200, 52, "8. Verdict", "from the breach log", tone="blue", icon="check", size=16, sub_size=13)
d.save()
