from diag import Diagram

d = Diagram(
    "architecture-breach", 1000, 680,
    "The MandateVault records the breach, the keeper files the claim, ClaimsEngine slashes "
    "OperatorBond first and has CoverPool pay the rest, and the money goes back into the vault.",
)

d.node(290, 30, 420, 76, "MandateVault records the breach", tone="orange", icon="vault", glow=True)
d.node(320, 156, 360, 76, "Keeper files the claim", icon="clock")
d.node(320, 282, 360, 76, "ClaimsEngine", "splits the payout", icon="scale", tone="blue")
d.node(100, 432, 300, 76, "OperatorBond", "the operator's stake", icon="server", tone="blue")
d.node(600, 432, 300, 76, "CoverPool", "underwriters' capital", icon="server", tone="blue")
d.node(290, 574, 420, 76, "Money goes back into the vault", tone="blue", icon="vault", glow=True)

d.line([(500, 108), (500, 154)], "orange")
d.line([(500, 234), (500, 280)], "blue")
d.line([(500, 360), (500, 395), (250, 395), (250, 430)], "blue", radius=14)
d.line([(500, 360), (500, 395), (750, 395), (750, 430)], "blue", radius=14)
d.chip(340, 395, "1. slash first", "blue")
d.chip(660, 395, "2. pay the rest", "blue")
d.line([(250, 510), (250, 541), (500, 541), (500, 572)], "blue", radius=14)
d.line([(750, 510), (750, 541), (500, 541)], "blue", radius=14, arrow=False)
d.save()
