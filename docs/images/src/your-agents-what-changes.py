from diag import Diagram
from _shared import alt, steps

d = Diagram("your-agents-what-changes", 1000, 320, alt("docs/YOUR-AGENTS.md", "your-agents-what-changes"))
d.panel(24, 24, 952, 272)
steps(d, [
    ("search", "Before you trust it", ["attacked, score", "published"], "plain"),
    ("shield-check", "While it runs", ["every write", "checked"], "blue"),
    ("snow", "If it's tricked", ["breach recorded,", "agent frozen"], "orange"),
    ("coins", "You get paid", ["bond first,", "then cover pool"], "blue"),
], y=122, x0=150, x1=850)
d.save()
