from diag import Diagram
from _shared import alt, steps

d = Diagram("byoa-test-steps", 1000, 300, alt("docs/BRING-YOUR-OWN-AGENT.md", "byoa-test-steps"))
d.panel(24, 24, 952, 252)
steps(d, [
    ("key", "Sign in", [], "plain"),
    ("plug", "Connect", [], "plain"),
    ("pulse", "Check", ["no attack"], "plain"),
    ("play", "Preview", ["attacks run"], "orange"),
    ("doc", "Report", ["only you see it"], "blue"),
], y=118, x0=130, x1=870)
d.save()
