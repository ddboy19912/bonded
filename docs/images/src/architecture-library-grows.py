from diag import Diagram

d = Diagram(
    "architecture-library-grows", 1000, 440,
    "A bounty hunter submits an attack to BountyBoard, accepted attacks join the attack library, "
    "the library feeds the Arena, and the bar rises.",
)

W, H = 270, 76
d.node(40, 50, W, H, "Bounty hunter", icon="user")
d.node(690, 50, W, H, "BountyBoard", "contract", icon="server", tone="blue")
d.node(690, 314, W, H, "Attack library", icon="book", tone="blue")
d.node(40, 314, W, H, "Arena", "runs it on every agent", icon="target", tone="blue")

d.line([(312, 88), (688, 88)], "blue")
d.chip(500, 88, "submits an attack", "blue")
d.line([(825, 128), (825, 312)], "blue")
d.chip(825, 220, "if accepted, joins", "blue")
d.line([(688, 352), (312, 352)], "blue")
d.chip(500, 352, "feeds", "blue")

# The bar rises: every accepted attack is run against every rated agent.
d.line([(392, 272), (610, 272)], "plain", arrow=False, width=1)
d.line([(400, 258), (450, 240), (500, 248), (600, 180)], "blue", width=2.5, radius=10)
d.chip(500, 176, "the bar rises", "blue")
d.save()
