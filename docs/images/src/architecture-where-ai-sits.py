from diag import Diagram

d = Diagram(
    "architecture-where-ai-sits", 1000, 330,
    "Off chain, Sentinel (AI, advisory) may refuse the AI agent's action; every action goes to the "
    "MandateVault on chain, which is deterministic.",
)

d.panel(24, 24, 612, 282, "Off chain", "AI lives here", dashed=True)
d.panel(676, 24, 300, 282, "On chain", "code decides", tone="blue")

Y, H = 118, 128
d.node(48, Y, 192, H, "Sentinel", "AI, advisory", icon="eye", align="center")
d.node(398, Y, 184, H, "AI agent", icon="terminal", tone="blue", align="center")
d.node(716, Y, 226, H, "MandateVault", "deterministic", icon="vault", tone="blue", align="center", glow=True)

cy = Y + H / 2
d.line([(242, cy), (396, cy)], "plain", dashed=True)
d.chip(319, cy, "may refuse")
d.line([(584, cy), (714, cy)], "blue")
d.chip(649, cy, "every action", "blue")
d.save()
