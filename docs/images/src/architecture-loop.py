from diag import Diagram

d = Diagram(
    "architecture-loop", 1000, 560,
    "The loop: the Arena attacks the agent, scores are signed on chain, cover is priced from the "
    "score, and a breach pays the claim.",
)

W, H = 352, 76
top = (324, 40)
right = (624, 242)
bottom = (324, 444)
left = (24, 242)

d.node(*top, W, H, "Arena attacks the agent", tone="orange", icon="target", glow=True)
d.node(*right, W, H, "Scores signed on chain", tone="blue", icon="chain")
d.node(*bottom, W, H, "Cover priced from the score", tone="blue", icon="shield")
d.node(*left, W, H, "A breach pays the claim", tone="blue", icon="coins")

for n, (x, y) in enumerate([top, right, bottom, left], 1):
    d.badge(x + W - 2, y + 2, n)

# Clockwise, corner to corner.
d.line([(678, 78), (800, 78), (800, 240)], "blue", radius=40)
d.line([(800, 320), (800, 482), (678, 482)], "blue", radius=40)
d.line([(322, 482), (200, 482), (200, 320)], "blue", radius=40)
d.line([(200, 240), (200, 78), (322, 78)], "blue", radius=40)

d.icon("refresh", 500, 281, 44, "#3a4a7a", 1.6)
d.save()
