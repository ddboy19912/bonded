from diag import Diagram
from _shared import alt

d = Diagram("contracts-overview", 1200, 800, alt("contracts/evm/README.md", "contracts-overview"))

S = 18  # title size: this picture is crowded


def n(x, y, w, title, icon, tone="plain", h=60, sub=None):
    d.node(x, y, w, h, title, sub, tone=tone, icon=icon, size=S, sub_size=14)


# People and the agent, down the left
n(22, 60, 198, "Operator", "user")
n(22, 190, 198, "AI agent", "terminal", "blue")
n(22, 310, 198, "Depositors", "users")
n(22, 470, 198, "Underwriters", "users")
n(22, 670, 198, "Arena attester", "shield-check")

# Contracts
n(300, 50, 270, "MandateVaultFactory", None)
d.node(360, 250, 230, 140, "MandateVault", "the agent's rules", tone="blue", icon="vault", glow=True,
       align="center", size=20, sub_size=14)
n(650, 296, 130, "Market", None, h=60)
n(790, 50, 200, "OperatorBond", None)
n(790, 232, 190, "ClaimsEngine", None)
n(1005, 330, 175, "DisputeModule", None)
n(790, 530, 190, "CoverManager", None)
n(1005, 530, 175, "CoverPool", None)
n(790, 670, 200, "BondedRegistry", None)

B, O = "blue", "orange"
# The operator sets it all up
d.line([(220, 90), (298, 90)], B)
d.chip(259, 90, "creates", B, size=14)
d.line([(125, 58), (125, 26), (890, 26), (890, 48)], B)
d.chip(500, 26, "locks bond", B, size=14)
d.line([(22, 90), (12, 90), (12, 772), (890, 772), (890, 732)], B)
d.chip(450, 772, "registers", B, size=14)

# Money and trades into the vault
d.line([(220, 220), (290, 220), (290, 290), (358, 290)], B)
d.chip(290, 254, "trades", B, size=14)
d.line([(220, 340), (358, 340)], B)
d.chip(289, 340, "deposit", B, size=14)
d.line([(592, 326), (648, 326)], B)
d.text(715, 374, "allowed trades only", 13, 400, "#a9b1bf")

# Premiums
d.line([(475, 392), (475, 560), (788, 560)], B)
d.chip(630, 560, "premiums", B, size=14)
d.line([(982, 560), (1003, 560)], B)

# Underwriters fund the pool
d.line([(220, 500), (250, 500), (250, 640), (1092, 640), (1092, 592)], B)
d.chip(660, 640, "deposit", B, size=14)

# A breach: the engine reads it, slashes the bond first, the pool pays the rest
d.line([(592, 262), (788, 262)], O)
d.chip(690, 262, "reads breaches", O, size=14)
d.line([(885, 230), (885, 112)], O)
d.chip(885, 152, "1. slash", O, size=14)
d.line([(960, 294), (960, 440), (1092, 440), (1092, 528)], O)
d.chip(1026, 440, "2. pay rest", O, size=14)
d.line([(1092, 328), (1092, 262), (982, 262)], O)
d.chip(1092, 295, "grey-area", O, size=13)

# Payouts back into the vault
d.line([(788, 95), (700, 95), (700, 180), (475, 180), (475, 248)], B)
d.line([(1180, 560), (1192, 560), (1192, 180), (700, 180)], B, arrow=False)
d.chip(588, 180, "payout", B, size=14)

# Scores
d.line([(220, 700), (788, 700)], B)
d.chip(500, 700, "signs scores", B, size=14)
d.save()
