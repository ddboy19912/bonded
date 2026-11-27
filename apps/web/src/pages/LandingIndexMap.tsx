import type { BondedIndexEntry } from "@bondedhq/shared";
import { useEffect, useRef, useState } from "react";
import { taskScore } from "../lib/bonded-index";
import { PROVIDER_LOGOS } from "../lib/provider-logos";
import { useInView, useReducedMotion } from "../lib/reveal";

/** A score's place across the plot, in percent, with room at both edges for a dot. */
export const at = (v: number) => 4 + v * 0.92;

/** What each corner of the map means. Split at 50 on both scores. */
export const corner = (security: number, task: number) =>
  security >= 50
    ? task >= 50
      ? "Hard to trick, still does the job"
      : "Safe because it refuses"
    : task >= 50
      ? "Does the job, easy to trick"
      : "Easy to trick, little done";

/** The same, short enough for a phone. */
const cornerShort = (security: number, task: number) =>
  security >= 50
    ? task >= 50
      ? "Safe and useful"
      : "Refuses"
    : task >= 50
      ? "Tricked"
      : "Neither";

/** The four corners, each named in the plot's own corner. */
const CORNERS = [
  { s: 75, t: 75, x: "right", y: "top" },
  { s: 25, t: 75, x: "left", y: "top" },
  { s: 75, t: 25, x: "right", y: "bottom" },
  { s: 25, t: 25, x: "left", y: "bottom" },
] as const;

export interface MapPoint {
  entry: BondedIndexEntry;
  security: number;
  task: number;
}

/** The goal: hard to trick, and still does the job. */
export const isGoal = (p: { security: number; task: number }) => p.security >= 50 && p.task >= 50;

type Box = { left: number; top: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

const NARROW = 560;
const PAD = 14;

/** A model's marker: its provider's mark on a small white disc. Smaller on a phone. */
const markerSize = (width: number) => (width < NARROW ? 24 : 30);

/** A provider's mark, on a white disc so every brand colour (Z.ai's black too) reads on the dark ground. */
export function ProviderMark({ provider, className }: { provider: string; className: string }) {
  const src = PROVIDER_LOGOS[provider];
  return (
    // Decoration: the model's name always sits beside it.
    <span className={className} aria-hidden>
      {src ? <img src={src} alt="" /> : <b>{provider.slice(0, 1)}</b>}
    </span>
  );
}

/** Where a point's dot sits in the plot, in pixels from the top left. */
const dotAt = (p: { security: number; task: number }, width: number, height: number) => ({
  x: (at(p.security) / 100) * width,
  y: height - (at(p.task) / 100) * height,
});

/**
 * Where each corner's name goes: in its corner, or slid along the edge toward the middle (never
 * past it) until it clears every marker, so a model at the very edge is never hidden under a name.
 * A corner with no clear spot (a crowded corner on a phone) goes without its name: the blue wash
 * and the axes still say what it is.
 */
export function placeCorners(points: MapPoint[], width: number, height: number): (Box | null)[] {
  const narrow = width < NARROW;
  // The corner names are set in the sans at 15px (13px on a phone): about half an em a letter.
  const font = narrow ? 13 : 15;
  const size = markerSize(width) + 8;
  const dots: Box[] = points.map((p) => {
    const { x, y } = dotAt(p, width, height);
    return { left: x - size / 2, top: y - size / 2, width: size, height: size };
  });
  return CORNERS.map((c) => {
    const text = narrow ? cornerShort(c.s, c.t) : corner(c.s, c.t);
    const w = text.length * font * 0.57;
    const h = font + 8;
    const top = c.y === "top" ? PAD : height - PAD - h;
    const room = width / 2 - PAD - w;
    for (let slide = 0; slide <= Math.max(0, room); slide += 12) {
      const left = c.x === "left" ? PAD + slide : width - PAD - w - slide;
      for (const row of [0, h + 4]) {
        const box = { left, top: c.y === "top" ? top + row : top - row, width: w, height: h };
        if (!dots.some((d) => overlaps(d, box))) return box;
      }
    }
    return null;
  });
}

/**
 * Where each model's name goes: beside, above or below its dot, the first spot that stays in the
 * plot and clears every dot, the corner names and the names already placed. On a narrow plot a
 * name with no free spot is left off (the ledger under the map names every model); on a wide one
 * it goes beside the dot anyway.
 */
export function placeLabels(
  points: MapPoint[],
  width: number,
  height: number,
): Map<string, { left: number; top: number } | null> {
  const narrow = width < NARROW;
  const font = narrow ? 13 : 15;
  const dot = markerSize(width);
  const gap = dot / 2 + 8;
  const xy = (p: MapPoint) => dotAt(p, width, height);
  const dots: Box[] = points.map((p) => {
    const { x, y } = xy(p);
    return { left: x - dot / 2, top: y - dot / 2, width: dot, height: dot };
  });
  const placed: Box[] = placeCorners(points, width, height).filter((b): b is Box => b !== null);
  const out = new Map<string, { left: number; top: number } | null>();
  points.forEach((p, i) => {
    const { x, y } = xy(p);
    const w = p.entry.label.length * font * 0.55 + 4;
    const h = font + 6;
    const candidates: Box[] = [
      { left: x + gap, top: y - h / 2, width: w, height: h },
      { left: x - gap - w, top: y - h / 2, width: w, height: h },
      { left: x - w / 2, top: y - gap - h, width: w, height: h },
      { left: x - w / 2, top: y + gap, width: w, height: h },
      { left: x + gap, top: y - h, width: w, height: h },
      { left: x + gap, top: y, width: w, height: h },
      { left: x - gap - w, top: y - h, width: w, height: h },
      { left: x - gap - w, top: y, width: w, height: h },
      // Above or below, lined up with the dot's right or left edge: for dots near a side.
      { left: x + dot / 2 - w, top: y - gap - h, width: w, height: h },
      { left: x + dot / 2 - w, top: y + gap, width: w, height: h },
      { left: x - dot / 2, top: y - gap - h, width: w, height: h },
      { left: x - dot / 2, top: y + gap, width: w, height: h },
      // A row further out, for two dots that sit almost on top of each other.
      { left: x + dot / 2 - w, top: y - gap - 2 * h, width: w, height: h },
      { left: x + dot / 2 - w, top: y + gap + h, width: w, height: h },
    ];
    const free = candidates.find(
      (c) =>
        c.left >= 0 &&
        c.top >= 0 &&
        c.left + c.width <= width &&
        c.top + c.height <= height &&
        !placed.some((b) => overlaps(b, c)) &&
        !dots.some((d, j) => j !== i && overlaps(d, c)),
    );
    const chosen = free ?? (narrow ? null : candidates[x > width * 0.75 ? 1 : 0]!);
    if (chosen) placed.push(chosen);
    out.set(p.entry.model, chosen ? { left: chosen.left, top: chosen.top } : null);
  });
  return out;
}

/** The models that have both scores, as points on the map. */
export function mapPoints(entries: BondedIndexEntry[]): MapPoint[] {
  return entries.flatMap((entry) => {
    const task = taskScore(entry);
    return task === null ? [] : [{ entry, security: entry.score, task }];
  });
}

/**
 * Security across, Task up: every model on one map, each marked with its provider's logo, the
 * corner you want in blue. The markers rise from the baseline into place the first time the map
 * comes on screen. Pointing at one shows its two scores and lights its row in the ledger above;
 * pointing at a row lights its marker. The ledger is the map's text version, so the map itself is
 * hidden from assistive technology.
 */
export function IndexMap({
  points,
  active,
  onActive,
}: {
  points: MapPoint[];
  active: string | null;
  onActive: (model: string | null) => void;
}) {
  const reduced = useReducedMotion();
  const plot = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [frame, seen] = useInView<HTMLDivElement>("0px 0px -20% 0px");
  const shown = seen || reduced;

  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const narrow = size.width > 0 && size.width < NARROW;
  const labels = size.width ? placeLabels(points, size.width, size.height) : new Map();
  const corners = size.width ? placeCorners(points, size.width, size.height) : null;
  const focus = points.find((p) => p.entry.model === active);

  return (
    <div ref={frame} className="l-map" aria-hidden data-shown={shown}>
      <p className="l-map-y">
        <b>Task</b> still pays the real bills <span>→</span>
      </p>
      <div ref={plot} className="l-plot" onMouseLeave={() => onActive(null)}>
        <span className="l-goal" style={{ left: `${at(50)}%`, bottom: `${at(50)}%` }} />
        <span className="l-mid l-mid-x" style={{ left: `${at(50)}%` }} />
        <span className="l-mid l-mid-y" style={{ bottom: `${at(50)}%` }} />
        {CORNERS.map((c, i) => {
          const box = corners?.[i];
          // Measured and crowded out: no name for this corner.
          if (corners && !box) return null;
          return (
            <span
              key={`${c.s}-${c.t}`}
              className="l-corner"
              data-goal={isGoal({ security: c.s, task: c.t })}
              style={box ? { left: box.left, top: box.top } : { [c.x]: PAD, [c.y]: PAD }}
            >
              {narrow ? cornerShort(c.s, c.t) : corner(c.s, c.t)}
            </span>
          );
        })}

        {points.map((p, i) => {
          const label = labels.get(p.entry.model);
          const on = active === p.entry.model;
          const dim = active !== null && !on;
          return (
            <div key={p.entry.model} data-goal={isGoal(p)} data-on={on} data-dim={dim}>
              <span
                className="l-dot"
                onMouseEnter={() => onActive(p.entry.model)}
                onClick={() => onActive(on ? null : p.entry.model)}
                style={{
                  left: `${at(p.security)}%`,
                  bottom: `${at(shown ? p.task : 0)}%`,
                  opacity: shown ? undefined : 0,
                  transitionDelay: reduced || !shown ? undefined : `${i * 80}ms`,
                }}
              >
                <ProviderMark provider={p.entry.provider} className="l-pmark" />
              </span>
              {label && (
                <span
                  className="l-dotname"
                  style={{
                    left: label.left,
                    top: label.top,
                    transitionDelay:
                      shown && !reduced && active === null ? `${900 + i * 80}ms` : undefined,
                  }}
                >
                  {p.entry.label}
                </span>
              )}
            </div>
          );
        })}

        {focus && (
          <div
            className="l-tip"
            data-below={focus.task > 78}
            style={{
              left: `clamp(110px, ${at(focus.security)}%, calc(100% - 110px))`,
              bottom: `${at(focus.task)}%`,
            }}
          >
            <p>
              <ProviderMark provider={focus.entry.provider} className="l-pmark" />
              {focus.entry.label}
            </p>
            <dl>
              <div>
                <dt>Security</dt>
                <dd>{focus.security}</dd>
              </div>
              <div>
                <dt>Task</dt>
                <dd>{focus.task}</dd>
              </div>
            </dl>
          </div>
        )}
      </div>
      <div className="l-map-x">
        {[0, 50, 100].map((v) => (
          <span key={v} className="l-tick" style={{ left: `${at(v)}%` }}>
            {v}
          </span>
        ))}
        <span className="l-map-xname">
          <b>Security</b> harder to trick <span>→</span>
        </span>
      </div>
    </div>
  );
}
