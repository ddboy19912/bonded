from diag import Diagram
from _shared import alt, steps

d = Diagram("bounties-flow", 1000, 330, alt("docs/BOUNTIES-EXPLAINED.md", "bounties-flow"))
d.panel(24, 24, 952, 282)
steps(d, [
    ("doc", "1. Write", ["the attack"], "plain"),
    ("hash", "2. Commit", ["a hash: timestamped,", "unreadable"], "plain"),
    ("lock", "3. Reveal", ["the attack"], "plain"),
    ("upload", "4. Send", ["the text"], "plain"),
    ("target", "5. Arena tests", ["3 runs undefended,", "3 runs defended"], "orange"),
    ("coins", "6. Paid, added", ["every agent", "re-rated"], "blue"),
], y=120, x0=110, x1=890)
d.save()
