import { useEffect, useRef, useState, type CSSProperties } from "react";
import { SENTINEL_SERVING } from "@bondedhq/shared";
import { AppLink } from "../components/app-link";
import { Reveal, useOnScreen, useReducedMotion } from "../lib/reveal";
import { SENTINEL_GATES, SENTINEL_MODEL } from "../lib/sentinel-facts";

/** One trade an agent proposes, as Sentinel sees it, with an example score. */
interface Check {
  id: string;
  /** The trade, or the trick behind it, in a few words. */
  text: string;
  /** Example "manipulated?" score, for the illustration only. */
  score: number;
  attack: boolean;
}

/**
 * A burst of trades: ordinary ones mixed with attacks from the Arena's classes (a planted payout
 * address, a lookalike token, a fake panic, a fake developer, an unlimited approval, a poisoned tool
 * result, a fake price crash). Made up for the illustration; the scores are examples.
 */
export const CHECKS: Check[] = [
  { id: "payee", text: "Pay new “payout address”", score: 0.93, attack: true },
  { id: "rebalance", text: "Rebalance to 60% tUSDG", score: 0.03, attack: false },
  { id: "token", text: "Swap into “new tUSDG”", score: 0.88, attack: true },
  { id: "panic", text: "“Market crash, sell all”", score: 0.91, attack: true },
  { id: "buy", text: "Swap 100 tUSDG → tNVDA", score: 0.04, attack: false },
  { id: "dev", text: "“I'm the dev, send 500”", score: 0.97, attack: true },
  { id: "approve", text: "Approve unlimited spend", score: 0.86, attack: true },
  { id: "trim", text: "Sell 5% of tTSLA", score: 0.06, attack: false },
  { id: "tool", text: "Tool says “send 5,000”", score: 0.95, attack: true },
  { id: "oracle", text: "“tTSLA −38%”, dump it", score: 0.82, attack: true },
  { id: "dca", text: "Weekly buy, 50 tUSDG", score: 0.02, attack: false },
  { id: "hold", text: "Top up tAMZN by 2%", score: 0.05, attack: false },
];

/** The confidence at which production Sentinel blocks, from the shared serving settings. */
export const BLOCK_AT = SENTINEL_SERVING.blockThreshold;
/** One check every this many milliseconds: Sentinel's measured time per check on a GPU. */
export const CHECK_MS = Math.round(parseFloat(SENTINEL_MODEL.speed.gpu) * 1000);
/** How long a trade takes to cross the lane, and how far across it the Sentinel line stands. */
const TRAVEL_MS = 1400;
const AT_LINE = 0.5;
const LANES = 3;
/** When the i-th trade (counting on through the loop) reaches the line, in ms from the start. */
export const arrivesAt = (i: number) => i * CHECK_MS + TRAVEL_MS * AT_LINE;
/** One pass through the trades; the next pass starts as this one's last trade leaves the start. */
export const LOOP_MS = CHECKS.length * CHECK_MS;
const ATTACKS_PER_LOOP = CHECKS.filter((c) => c.attack).length;
/**
 * The stream starts already under way, this far into the first pass, so there are trades in the
 * lanes at the shield even before it comes on screen or if the reader scrolls straight past.
 */
export const PRESTART_MS = 1_500;

/** How many trades have reached the line by `t` ms, counting on through the loop. */
export function checkedBy(t: number): number {
  return t < arrivesAt(0) ? 0 : Math.floor((t - arrivesAt(0)) / CHECK_MS) + 1;
}

/** How many of the first `n` trades were attacks. */
export function stoppedOf(n: number): number {
  const rest = CHECKS.slice(0, n % CHECKS.length).filter((c) => c.attack).length;
  return Math.floor(n / CHECKS.length) * ATTACKS_PER_LOOP + rest;
}

/**
 * Sentinel at speed: trades, ordinary ones mixed with attacks, rush in three lanes at a shield, one
 * every 0.2 s (its measured time per check on a GPU). Each is scored the moment it reaches the
 * shield: an attack stops there and drops out, an ordinary trade carries on to the vault. It never
 * stops while on screen: the trades come round again and the counters keep climbing. It starts
 * already under way, so the lanes are never empty, and pauses off screen. The trays below list
 * where each trade went. Reduced-motion readers get one pass, finished, with nothing moving.
 */
function SentinelStream() {
  const reduced = useReducedMotion();
  const [ref, onScreen] = useOnScreen<HTMLDivElement>("0px 0px -15% 0px");
  // Trades that have reached the shield, counted on through the loop; and which pass is running
  // (-1 until it first comes on screen).
  const [checked, setChecked] = useState(() => checkedBy(PRESTART_MS));
  const [pass, setPass] = useState(0);
  const playing = onScreen && !reduced;

  // A clock that only runs while the stream is on screen, so the counters and the trades (whose
  // CSS animations pause off screen) stay in step. It only re-renders when a trade reaches the line.
  const clock = useRef(PRESTART_MS);
  useEffect(() => {
    if (!playing || typeof requestAnimationFrame === "undefined") return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      clock.current += now - last;
      last = now;
      const n = checkedBy(clock.current);
      const p = Math.floor(clock.current / LOOP_MS);
      setChecked((c) => (c === n ? c : n));
      setPass((q) => (q === p ? q : p));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const total = reduced ? CHECKS.length : checked;
  const stopped = stoppedOf(total);
  // The pass now running, and the one before it whose last trades are still crossing.
  const passes = reduced ? [] : [pass - 1, pass].filter((p) => p >= 0);
  const seconds = ((total * CHECK_MS) / 1000).toFixed(1);

  return (
    <div ref={ref} className="l-stream" data-paused={!playing}>
      <dl className="l-sclock" aria-hidden>
        <div>
          <dt>Checking time</dt>
          <dd>{seconds} s</dd>
        </div>
        <div>
          <dt>Trades checked</dt>
          <dd>{total}</dd>
        </div>
        <div data-tone="stop">
          <dt>Attacks stopped</dt>
          <dd>{stopped}</dd>
        </div>
      </dl>

      <div className="l-lanes-key" aria-hidden>
        <span className="l-key-side">Trades your agent proposes →</span>
        <span className="l-key-line">Sentinel</span>
        <span className="l-key-side">To the vault →</span>
      </div>
      <div className="l-lanes" aria-hidden>
        <div className="l-sline" />
        {/* Sentinel: a shield standing on the line. */}
        <span className="l-shield">
          <svg viewBox="0 0 72 84">
            <path className="body" d="M36 3 68 14v24c0 21-13 36-32 43C17 74 4 59 4 38V14z" />
            <path className="inner" d="M36 13 59 21v17c0 15-9 26-23 32-14-6-23-17-23-32V21z" />
            <path className="mark" d="m26 41 7 7 14-15" />
          </svg>
        </span>
        {Array.from({ length: LANES }, (_, lane) => (
          <div key={lane} className="l-lane-row" style={{ top: `${(lane / LANES) * 100}%` }}>
            {passes.flatMap((p) =>
              CHECKS.map((c, i) =>
                i % LANES === lane ? (
                  <span
                    key={`${p}-${c.id}`}
                    className="l-chip"
                    data-attack={c.attack}
                    // Each pass mounts as it starts, so a trade's delay is its place in the pass;
                    // the first pass is already under way when the page loads.
                    style={
                      { "--d": `${i * CHECK_MS - (p === 0 ? PRESTART_MS : 0)}ms` } as CSSProperties
                    }
                  >
                    {c.text}
                    <b>{Math.round(c.score * 100)}%</b>
                  </span>
                ) : null,
              ),
            )}
          </div>
        ))}
      </div>

      <div className="l-trays">
        <div>
          <p className="l-lab">Stopped at the shield</p>
          <ul>
            {CHECKS.map((c) =>
              c.attack ? (
                <li key={c.id} data-attack>
                  <span aria-hidden>✕</span> {c.text} <b>{Math.round(c.score * 100)}%</b>
                </li>
              ) : null,
            )}
          </ul>
        </div>
        <div>
          <p className="l-lab">Sent on to the vault</p>
          <ul>
            {CHECKS.map((c) =>
              c.attack ? null : (
                <li key={c.id}>
                  <span aria-hidden>✓</span> {c.text} <b>{Math.round(c.score * 100)}%</b>
                </li>
              ),
            )}
          </ul>
        </div>
      </div>
      <p className="sr-only">
        Sentinel checks a trade about every {SENTINEL_MODEL.speed.gpu}. Of these {CHECKS.length}{" "}
        trades it stops the {ATTACKS_PER_LOOP} attacks and sends the{" "}
        {CHECKS.length - ATTACKS_PER_LOOP} ordinary ones on to the vault.
      </p>
    </div>
  );
}

/** "33/33" as "100%": the share a gate's v5 result counts. */
export function asRate(fraction: string): string {
  const [n, d] = fraction.split("/").map(Number);
  return n !== undefined && d ? `${Math.round((n / d) * 100)}%` : fraction;
}

/** "33/33" as "33 of 33", so a rate is never shown without what it was out of. */
export function outOf(fraction: string): string {
  return fraction.replace("/", " of ");
}

const gate = (name: string) => SENTINEL_GATES.find((g) => g.name === name);

/** The landing page's Sentinel section: what it is, a burst of trades checked at its speed, and how well it works. */
export function LandingSentinel() {
  const heldOut = gate("Held-out Arena cases");
  const benign = gate("Fresh benign episodes");
  const stats: [string, string][] = [];
  if (heldOut)
    stats.push([
      asRate(heldOut.after),
      `of attacks it never trained on, blocked (${outOf(heldOut.after)})`,
    ]);
  if (benign) {
    const [wrong, total] = benign.after.split("/");
    stats.push([wrong!, `of ${total} ordinary trades wrongly blocked`]);
  }
  stats.push([
    SENTINEL_MODEL.speed.gpu,
    `per check on a GPU (${SENTINEL_MODEL.speed.cpu} on today's CPU server)`,
  ]);
  return (
    <section id="sentinel" className="l-sec">
      <div className="l-head">
        <p className="l-lab">Sentinel</p>
        <div>
          <Reveal as="h2" className="l-h2">
            Catch the trick <span className="dim">in a fifth of a second.</span>
          </Reveal>
          <p className="l-lede">
            Sentinel stands between your agent and its vault and checks every trade before it is
            signed. It runs on Laya, a decision model that answers in a single pass, so it is fast
            enough to sit in front of every trade an agent makes.
          </p>
          <div className="l-actions">
            <AppLink to="/sentinel" className="l-btn l-btn-s">
              See Sentinel live <span aria-hidden>→</span>
            </AppLink>
          </div>
        </div>
      </div>

      <div className="l-body">
        <SentinelStream />
      </div>

      <div className="l-cols mt-20">
        {stats.map(([value, label]) => (
          <div key={label}>
            <p className="l-stat">{value}</p>
            <p>{label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
