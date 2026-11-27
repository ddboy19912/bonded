from diag import Diagram

d = Diagram(
    "architecture-money", 1000, 420,
    "The depositor pays a premium to CoverManager, the agent operator stakes a bond in "
    "OperatorBond, and underwriters supply capital to CoverPool.",
)

rows = [
    ("Depositor", "user", "pays a premium", "CoverManager"),
    ("Agent operator", "user", "stakes a bond", "OperatorBond"),
    ("Underwriters", "users", "supply capital", "CoverPool"),
]
for i, (who, icon, verb, contract) in enumerate(rows):
    y = 24 + i * 128
    d.panel(24, y, 952, 112)
    cy = y + 56
    d.node(52, cy - 36, 270, 72, who, icon=icon)
    d.node(678, cy - 36, 270, 72, contract, "contract", icon="server", tone="blue")
    d.line([(324, cy), (676, cy)], "blue")
    d.chip(500, cy, verb, "blue")
d.save()
