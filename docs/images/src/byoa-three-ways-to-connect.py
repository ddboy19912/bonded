from diag import Diagram, TEXT

d = Diagram(
    "byoa-three-ways-to-connect", 1000, 560,
    "Three ways to connect: the runner connects out from your machine to Bonded; with an Agent URL, "
    "Bonded sends a signed call to your web service; or Bonded runs your agent's code itself. "
    "Same test, same judging.",
)

cols = [
    ("Runner", "Your machine connects out", ("Your machine", "terminal", "runner, no open port"), "up", "connects out"),
    ("Agent URL", "Bonded calls your service", ("Your web service", "globe", "a public HTTPS URL"), "down", "signed call"),
    ("Bonded runs it", "You hand over the code", ("Your agent's code", "doc", "run in Bonded's sandbox"), "up", "upload"),
]
W, X0, GAP = 300, 34, 16
for i, (title, sub, (low, icon, low_sub), way, verb) in enumerate(cols):
    x = X0 + i * (W + GAP)
    d.panel(x, 32, W, 420, title, sub)
    bx, bw = x + 20, W - 40
    d.node(bx, 140, bw, 72, "Bonded", "the test and the judge", tone="blue", icon="bonded")
    d.node(bx, 344, bw, 72, low, low_sub, icon=icon)
    cx = x + W / 2
    if way == "up":
        d.line([(cx, 344), (cx, 214)], "blue")
    else:
        d.line([(cx, 212), (cx, 342)], "blue")
    d.chip(cx, 278, verb, "blue")

d.line([(60, 494), (940, 494)], "plain", arrow=False, width=1)
d.chip(500, 494, "Same test, same judging", "plain", size=17, fill="#0d1018")
d.save()
