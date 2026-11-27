from diag import Diagram

d = Diagram(
    "architecture-rating", 1000, 600,
    "The Arena plants attacks on the AI agent, which acts through the MandateVault; the vault's "
    "breach log goes back to the Arena, which posts a signed score to BondedRegistry, and the same "
    "score to Arbitrum, Ethereum and Solana.",
)

Y, H = 150, 76
d.node(30, Y, 210, H, "Arena", "runs the attacks", icon="target")
d.node(400, Y, 190, H, "AI agent", icon="terminal", tone="blue")
d.node(750, Y, 220, H, "MandateVault", "checks every call", icon="vault", tone="blue")

d.line([(242, Y + 38), (398, Y + 38)], "orange")
d.chip(320, Y + 38, "plants attacks", "orange")
d.line([(592, Y + 38), (748, Y + 38)], "blue")
d.chip(670, Y + 38, "acts through", "blue")

# The verdict comes from the vault, not from the agent.
d.line([(860, Y - 2), (860, 64), (135, 64), (135, Y - 2)], "blue", radius=16)
d.chip(500, 64, "breach log", "blue")

RY = 400
d.node(330, RY, 260, H, "BondedRegistry", "signed score on chain", icon="bonded", tone="blue")
d.line([(135, Y + H + 2), (135, RY + 38), (328, RY + 38)], "blue", radius=16)
d.chip(135, 330, "signed score", "blue")

chains = [("Arbitrum", 300), ("Ethereum", 410), ("Solana", 520)]
for name, cy in chains:
    d.node(800, cy - 30, 170, 60, name, icon="chain")
    d.line([(592, RY + 38), (730, RY + 38), (730, cy), (798, cy)], "blue", dashed=True, radius=16)
d.chip(660, RY + 38, "same score", "blue")
d.save()
