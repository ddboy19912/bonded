import type { BondedIndexEntry } from "@bondedhq/shared";
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  LabelList,
  Line,
  LineChart,
  ReferenceArea,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import deepseek from "../assets/providers/deepseek.svg";
import meta from "../assets/providers/meta.svg";
import qwen from "../assets/providers/qwen.svg";
import zai from "../assets/providers/zai.svg";
import { DataTable, VIZ } from "./charts";

/** Each provider's mark, shown under its models' bars and as their points on a scatter. */
const LOGOS: Record<string, string> = { Meta: meta, DeepSeek: deepseek, "Z.ai": zai, Qwen: qwen };

const INK = "#f4f6fb";
const MUTED = "#8d96ab";
const AXIS = { fill: MUTED, fontSize: 11 };

/**
 * One color per provider, as Artificial Analysis does, from the validated categorical palette:
 * blue, yellow, magenta and green are the four slots that pass every check together on the card
 * surface (#0e1320), any two side by side. Their closest colour-blind pair (green and yellow) is
 * in the floor band, legal because every mark also carries its logo and name. A provider not
 * listed here takes the neutral.
 */
export const PROVIDER_COLORS: Record<string, string> = {
  Meta: "#3987e5",
  DeepSeek: "#008300",
  Qwen: "#d55181",
  "Z.ai": "#c98500",
};

export const colorOf = (e: Pick<BondedIndexEntry, "provider">) =>
  PROVIDER_COLORS[e.provider] ?? VIZ.other;

export function ProviderLogo({ provider, size = 18 }: { provider: string; size?: number }) {
  const src = LOGOS[provider];
  return (
    <span
      className="inline-grid shrink-0 place-items-center rounded-[5px] bg-white"
      style={{ width: size, height: size }}
      title={provider}
    >
      {src ? (
        <img src={src} alt="" width={size - 6} height={size - 6} />
      ) : (
        <span className="text-[9px] font-bold text-black">{provider.slice(0, 1)}</span>
      )}
    </span>
  );
}

/**
 * The width of a chart's box, measured before the first paint and kept current. The box hides
 * overflow, so the chart inside can't widen the box it's measured from. Where nothing can measure
 * (tests), a fixed width.
 */
function useWidth(fallback = 720) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.clientWidth > 0) setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** A chart's card: title, one line of subtitle, optional tabs, and a table view of its data. */
export function ChartCard({
  title,
  subtitle,
  tabs,
  tab,
  onTab,
  table,
  children,
  aside,
}: {
  title: string;
  subtitle?: ReactNode;
  tabs?: readonly { id: string; label: string }[];
  tab?: string;
  onTab?: (id: string) => void;
  table?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="min-w-0 rounded-2xl border border-line bg-surface/70 p-4 sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="flex items-center gap-2 text-lg font-semibold text-ink">
            <span aria-hidden className="size-2.5 rounded-[2px] bg-[#3987e5]" />
            {title}
          </h2>
          {subtitle && <p className="mt-1 text-xs text-muted">{subtitle}</p>}
        </div>
        {table && (
          <button
            type="button"
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
            className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-soft hover:border-line-strong hover:text-ink"
          >
            {showTable ? "Chart" : "Table"}
          </button>
        )}
      </div>
      {tabs && (
        <div role="tablist" aria-label={title} className="mt-4 flex gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              onClick={() => onTab?.(t.id)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs transition-colors ${
                t.id === tab
                  ? "bg-ink font-medium text-paper"
                  : "text-muted hover:bg-raised hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {aside && !showTable && <div className="mt-4">{aside}</div>}
      <div className="mt-3">
        {showTable && table ? <div className="overflow-x-auto">{table}</div> : children}
      </div>
    </section>
  );
}

export function Legend({ items }: { items: readonly { color: string; label: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-soft">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

function TipCard({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-64 rounded-lg border border-line-strong bg-raised px-3 py-2 text-xs text-soft shadow-xl">
      {children}
    </div>
  );
}

/** Round axis ticks from 0 past `max`, at most about `count` steps (1, 2, 2.5 or 5 × 10ⁿ). */
export function niceTicks(max: number, count = 4): number[] {
  const raw = Math.max(max, Number.EPSILON) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step || step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(10));
}

/** One bar per model, or a stack of several values per model. */
export interface ModelBar {
  entry: BondedIndexEntry;
  /** Shown above the bar. */
  label: string;
  values: Record<string, number>;
  /** Low and high of a 95% interval, drawn as a thin whisker on the first series. */
  interval?: [number, number];
  /** A warning shown under the model's name, such as a Task score under 50. */
  flag?: string;
  tip: ReactNode;
}

/**
 * Vertical bars, one per model in the order given, each named by its provider's logo and its
 * label under the axis (Artificial Analysis's layout). `series` names the stacked values and
 * their colors; a single series takes each model's provider color.
 */
export function ModelBars({
  bars,
  series,
  domain,
  ticks,
  format,
  height = 300,
  grouped = false,
}: {
  bars: readonly ModelBar[];
  series: readonly { key: string; label: string; color?: string }[];
  domain: [number, number];
  ticks?: number[];
  format: (v: number) => string;
  height?: number;
  /** Side by side, each labelled with its own value, instead of stacked under one label. */
  grouped?: boolean;
}) {
  const { ref, width } = useWidth();
  const narrow = width < 520;
  const data = bars.map((b) => ({
    model: b.entry.model,
    ...b.values,
    label: b.label,
    err: b.interval
      ? [
          Math.max(0, (b.values[series[0]!.key] ?? 0) - b.interval[0]),
          Math.max(0, b.interval[1] - (b.values[series[0]!.key] ?? 0)),
        ]
      : undefined,
  }));
  const byModel = new Map(bars.map((b) => [b.entry.model, b]));
  const single = series.length === 1;
  const last = series[series.length - 1]!.key;
  // For each bar, the index of its top series with a value (the last one when all are zero).
  const topSeries = bars.map((b) => {
    let top = series.length - 1;
    while (top > 0 && !(b.values[series[top]!.key]! > 0)) top--;
    return top;
  });
  return (
    <div ref={ref} className="w-full min-w-0 overflow-hidden">
      <BarChart
        width={width}
        height={height + (narrow ? 112 : 82)}
        data={data}
        margin={{ top: 22, right: 4, bottom: 0, left: -8 }}
        barCategoryGap={narrow ? "18%" : "26%"}
        accessibilityLayer
      >
        <CartesianGrid vertical={false} stroke={VIZ.grid} strokeDasharray="3 4" />
        <YAxis
          domain={domain}
          ticks={ticks}
          tickFormatter={format}
          tick={AXIS}
          axisLine={false}
          tickLine={false}
          width={48}
        />
        <XAxis
          dataKey="model"
          interval={0}
          height={narrow ? 112 : 82}
          axisLine={{ stroke: "rgb(255 255 255 / 0.16)" }}
          tickLine={false}
          tick={(props: {
            x?: number | string;
            y?: number | string;
            payload?: { value?: unknown };
          }) => {
            const bar = byModel.get(String(props.payload?.value));
            if (!bar) return <g />;
            return <ModelTick x={Number(props.x)} y={Number(props.y)} bar={bar} narrow={narrow} />;
          }}
        />
        <Tooltip
          cursor={{ fill: "rgb(255 255 255 / 0.04)" }}
          content={({ active, payload }) => {
            const model = payload?.[0]?.payload?.model as string | undefined;
            const bar = model ? byModel.get(model) : undefined;
            return active && bar ? <TipCard>{bar.tip}</TipCard> : null;
          }}
        />
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId={grouped ? undefined : "a"}
            // A zero still gets a hairline on the axis, so its label ("$0", "0%") shows.
            minPointSize={(value: number | null | undefined) => (value === 0 ? 1 : 0)}
            maxBarSize={narrow ? (grouped ? 14 : 26) : grouped ? 22 : 44}
            radius={grouped || s.key === last ? [4, 4, 0, 0] : 0}
            // A stack's lower segment rounds only when it's the top one with a value.
            shape={
              grouped || single
                ? undefined
                : (props: {
                    x?: number;
                    y?: number;
                    width?: number;
                    height?: number;
                    fill?: string;
                    index?: number;
                  }) => {
                    const top = props.index !== undefined && topSeries[props.index] === i;
                    const { x = 0, y = 0, width: w = 0, height: h = 0 } = props;
                    if (h <= 0) return <g />;
                    const r = top ? Math.min(4, w / 2, h) : 0;
                    return (
                      <path
                        d={`M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`}
                        fill={props.fill}
                        stroke="#0e1320"
                        strokeWidth={1.5}
                      />
                    );
                  }
            }
            isAnimationActive={false}
            // A thin gap between stacked parts, in the card's color.
            stroke={series.length > 1 && !grouped ? "#0e1320" : undefined}
            strokeWidth={series.length > 1 && !grouped ? 1.5 : 0}
          >
            {single &&
              data.map((d) => (
                <Cell key={d.model} fill={s.color ?? colorOf(byModel.get(d.model)!.entry)} />
              ))}
            {!single && data.map((d) => <Cell key={d.model} fill={s.color} />)}
            {i === 0 && data.some((d) => d.err) && (
              <ErrorBar dataKey="err" width={4} stroke="rgb(244 246 251 / 0.45)" strokeWidth={1} />
            )}
            {grouped && (
              <LabelList
                dataKey={s.key}
                position="top"
                offset={4}
                fill={INK}
                fontSize={narrow ? 9 : 10}
                formatter={(v: unknown) => format(Number(v))}
              />
            )}
            {!grouped && (
              <LabelList
                dataKey="label"
                content={(props: {
                  x?: number | string;
                  y?: number | string;
                  width?: number | string;
                  index?: number;
                  value?: unknown;
                }) =>
                  // The total sits on the top segment that has a value, so a stack whose last
                  // part is zero still shows it.
                  props.index !== undefined && topSeries[props.index] === i ? (
                    <text
                      x={Number(props.x) + Number(props.width) / 2}
                      y={Number(props.y) - 6}
                      textAnchor="middle"
                      fill={INK}
                      fontSize={narrow ? 10 : 11}
                      fontWeight={600}
                    >
                      {String(props.value ?? "")}
                    </text>
                  ) : null
                }
              />
            )}
          </Bar>
        ))}
      </BarChart>
    </div>
  );
}

/** A model's name in at most two lines, split where the lines come out most even. */
function splitName(name: string): string[] {
  const words = name.split(" ");
  if (name.length <= 12 || words.length < 2) return [name];
  let best: string[] = [name];
  for (let i = 1; i < words.length; i++) {
    const lines = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
    if (Math.max(...lines.map((l) => l.length)) < Math.max(...best.map((l) => l.length)))
      best = lines;
  }
  return best;
}

/** Under a bar: the provider's logo, then the model's name, turned so long names fit. */
function ModelTick({
  x,
  y,
  bar,
  narrow,
}: {
  x: number;
  y: number;
  bar: ModelBar;
  narrow: boolean;
}) {
  const src = LOGOS[bar.entry.provider];
  const size = narrow ? 16 : 18;
  const lines = splitName(bar.entry.label);
  const font = narrow ? 9.5 : 10.5;
  return (
    <g transform={`translate(${x},${y + 6})`}>
      <title>{bar.flag ? `${bar.entry.label}: ${bar.flag}` : bar.entry.label}</title>
      <rect x={-size / 2} y={0} width={size} height={size} rx={4} fill="#ffffff" />
      {src && <image href={src} x={-size / 2 + 3} y={3} width={size - 6} height={size - 6} />}
      <text
        transform={`translate(${narrow ? 3 : 5},${size + 9}) rotate(${narrow ? -70 : -40})`}
        textAnchor="end"
        fontSize={font}
        fill={bar.flag ? "#ffb347" : "#c7d2ee"}
      >
        {lines.map((line, i) => (
          <tspan key={line} x={0} dy={i === 0 ? 0 : font + 2}>
            {i === 0 && bar.flag ? `⚠ ${line}` : line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

/** One point per model, drawn as its provider's logo with its name beside it. */
export interface ModelPoint {
  entry: BondedIndexEntry;
  x: number;
  y: number;
  tip: ReactNode;
}

const SCATTER_MARGIN = { top: 18, right: 24, bottom: 30, left: 4 };
const Y_AXIS_WIDTH = 44;
const X_AXIS_HEIGHT = 30;

interface Placement {
  x: number;
  y: number;
  anchor: "start" | "end" | "middle";
  text: string;
}

/**
 * Where each model's name goes: right of its point, else left, above or below, the first spot
 * that stays inside the plot and clears every point and every name placed before it. Points on
 * the same spot share one name. A name with nowhere to go is left off (the tooltip and the table
 * still have it).
 */
function placeLabels(
  points: readonly ModelPoint[],
  toPx: (p: ModelPoint) => { x: number; y: number },
  bounds: { left: number; right: number; top: number; bottom: number },
  font: number,
  /** Other text already on the plot, such as a zone's label, as pixel boxes. */
  obstacles: readonly { l: number; r: number; t: number; b: number }[] = [],
): Map<string, Placement | null> {
  const charW = font * 0.62;
  const pts = points.map((p) => ({ p, ...toPx(p) }));
  const boxes: { l: number; r: number; t: number; b: number }[] = pts.map((q) => ({
    l: q.x - 12,
    r: q.x + 12,
    t: q.y - 12,
    b: q.y + 12,
  }));
  boxes.push(...obstacles);
  const placed = new Map<string, Placement | null>();
  const done = new Set<string>();
  // Top of the plot first, where points crowd.
  for (const q of [...pts].sort((a, b) => a.y - b.y)) {
    if (done.has(q.p.entry.model)) continue;
    const same = pts.filter((o) => o.p.x === q.p.x && o.p.y === q.p.y);
    for (const o of same) done.add(o.p.entry.model);
    const text = same.map((o) => o.p.entry.label).join(", ");
    const w = text.length * charW;
    const h = font + 2;
    const candidates: Placement[] = [
      { x: q.x + 15, y: q.y + font / 3, anchor: "start", text },
      { x: q.x - 15, y: q.y + font / 3, anchor: "end", text },
      { x: q.x, y: q.y - 16, anchor: "middle", text },
      { x: q.x, y: q.y + 16 + font / 2, anchor: "middle", text },
    ];
    const box = (c: Placement) => {
      const l = c.anchor === "start" ? c.x : c.anchor === "end" ? c.x - w : c.x - w / 2;
      return { l, r: l + w, t: c.y - h + 2, b: c.y + 2 };
    };
    const own = new Set(same.map((o) => pts.indexOf(o)));
    const fits = (c: Placement) => {
      const b = box(c);
      if (b.l < bounds.left || b.r > bounds.right || b.t < bounds.top || b.b > bounds.bottom)
        return false;
      return boxes.every((o, i) => own.has(i) || o.r < b.l || o.l > b.r || o.b < b.t || o.t > b.b);
    };
    const pick = candidates.find(fits) ?? null;
    if (pick) boxes.push(box(pick));
    for (const o of same) placed.set(o.p.entry.model, o === same[0] ? pick : null);
  }
  return placed;
}

export function ModelScatter({
  points,
  x,
  y,
  zone,
  height = 400,
}: {
  points: readonly ModelPoint[];
  x: {
    domain: [number, number];
    ticks?: number[];
    format: (v: number) => string;
    label: string;
    log?: boolean;
  };
  y: { domain: [number, number]; ticks?: number[]; format: (v: number) => string; label: string };
  /** A shaded region, the corner a reader wants to be in. */
  zone?: { x: [number, number]; y: [number, number]; label: string };
  height?: number;
}) {
  const { ref, width } = useWidth();
  const narrow = width < 520;
  const font = narrow ? 10 : 11;
  const byModel = new Map(points.map((p) => [p.entry.model, p]));
  const data = points.map((p) => ({ model: p.entry.model, x: p.x, y: p.y }));
  // The plot's pixel box, as Recharts lays it out with these margins and axis sizes.
  const plot = {
    left: SCATTER_MARGIN.left + Y_AXIS_WIDTH,
    right: width - SCATTER_MARGIN.right,
    top: SCATTER_MARGIN.top,
    bottom: height - SCATTER_MARGIN.bottom - X_AXIS_HEIGHT,
  };
  const scaleX = (v: number) => {
    const [a, b] = x.domain;
    const t = x.log ? Math.log10(v / a) / Math.log10(b / a) : (v - a) / (b - a);
    return plot.left + t * (plot.right - plot.left);
  };
  const scaleY = (v: number) =>
    plot.bottom - ((v - y.domain[0]) / (y.domain[1] - y.domain[0])) * (plot.bottom - plot.top);
  // Names may run into the margins, but not off the chart or over the axes.
  const room = { left: plot.left, right: width - 2, top: 2, bottom: plot.bottom };
  // The zone's own label sits at its bottom-left corner (Recharts' insideBottomLeft, 5px in).
  const zoneLabel =
    zone && !narrow
      ? [
          {
            l: scaleX(zone.x[0]) + 3,
            r: scaleX(zone.x[0]) + 7 + zone.label.length * font * 0.62,
            t: scaleY(zone.y[0]) - 7 - font,
            b: scaleY(zone.y[0]) - 2,
          },
        ]
      : [];
  const labels = placeLabels(
    points,
    (p) => ({ x: scaleX(p.x), y: scaleY(p.y) }),
    room,
    font,
    zoneLabel,
  );
  return (
    <div ref={ref} className="w-full min-w-0 overflow-hidden">
      <ScatterChart width={width} height={height} margin={SCATTER_MARGIN} accessibilityLayer>
        <CartesianGrid stroke={VIZ.grid} strokeDasharray="3 4" />
        {zone && (
          <ReferenceArea
            x1={zone.x[0]}
            x2={zone.x[1]}
            y1={zone.y[0]}
            y2={zone.y[1]}
            fill="#7ee2b0"
            fillOpacity={0.07}
            stroke="#7ee2b0"
            strokeOpacity={0.25}
            strokeDasharray="3 3"
            // On a phone the shading alone marks the corner; the card's subtitle names it.
            label={
              narrow
                ? undefined
                : {
                    value: zone.label,
                    position: "insideBottomLeft",
                    fill: "#7ee2b0",
                    fontSize: font,
                  }
            }
            ifOverflow="hidden"
          />
        )}
        <XAxis
          type="number"
          dataKey="x"
          domain={x.domain}
          ticks={x.ticks}
          scale={x.log ? "log" : "linear"}
          tickFormatter={x.format}
          tick={AXIS}
          tickLine={false}
          height={X_AXIS_HEIGHT}
          axisLine={{ stroke: "rgb(255 255 255 / 0.16)" }}
          label={{
            value: x.label,
            position: "insideBottom",
            offset: -18,
            fill: MUTED,
            fontSize: 11,
          }}
        />
        <YAxis
          type="number"
          dataKey="y"
          domain={y.domain}
          ticks={y.ticks}
          tickFormatter={y.format}
          tick={AXIS}
          tickLine={false}
          axisLine={false}
          width={Y_AXIS_WIDTH}
          label={{
            value: y.label,
            angle: -90,
            position: "insideLeft",
            offset: 10,
            fill: MUTED,
            fontSize: 11,
          }}
        />
        <Tooltip
          cursor={{ stroke: "rgb(255 255 255 / 0.16)", strokeDasharray: "3 3" }}
          content={({ active, payload }) => {
            const model = payload?.[0]?.payload?.model as string | undefined;
            const point = model ? byModel.get(model) : undefined;
            return active && point ? <TipCard>{point.tip}</TipCard> : null;
          }}
        />
        <Scatter
          data={data}
          isAnimationActive={false}
          shape={(props: { cx?: number; cy?: number; payload?: { model: string } }) => {
            const point = props.payload ? byModel.get(props.payload.model) : undefined;
            if (!point || props.cx === undefined || props.cy === undefined) return <g />;
            return (
              <LogoPoint
                cx={props.cx}
                cy={props.cy}
                point={point}
                label={labels.get(point.entry.model) ?? null}
                font={font}
              />
            );
          }}
        />
      </ScatterChart>
    </div>
  );
}

/** A model on the scatter: its logo in a ring of its provider color, and its placed name. */
function LogoPoint({
  cx,
  cy,
  point,
  label,
  font,
}: {
  cx: number;
  cy: number;
  point: ModelPoint;
  label: Placement | null;
  font: number;
}) {
  const src = LOGOS[point.entry.provider];
  return (
    <g>
      <title>{point.entry.label}</title>
      <circle
        cx={cx}
        cy={cy}
        r={11}
        fill="#ffffff"
        stroke={colorOf(point.entry)}
        strokeWidth={2.5}
      />
      {src && <image href={src} x={cx - 7} y={cy - 7} width={14} height={14} />}
      {label && (
        <text x={label.x} y={label.y} textAnchor={label.anchor} fontSize={font} fill="#c7d2ee">
          {label.text}
        </text>
      )}
    </g>
  );
}

/** One version of a model family on the across-versions chart. */
export interface VersionPoint {
  entry: BondedIndexEntry;
  security: number;
  task: number | null;
  tip: ReactNode;
}

/**
 * A family's versions in order, its security score as a solid line and its Task score as a
 * dashed one, both in the provider's color and both on the same 0-100 scale. Each point is
 * labelled with its value.
 */
export function VersionLines({
  points,
  height = 260,
}: {
  points: readonly VersionPoint[];
  height?: number;
}) {
  const { ref, width } = useWidth(360);
  const color = colorOf(points[0]!.entry);
  const data = points.map((p) => ({
    version: p.entry.version,
    model: p.entry.model,
    security: p.security,
    task: p.task,
  }));
  const byModel = new Map(points.map((p) => [p.entry.model, p]));
  // Each point's value goes on the side away from the other line: above for the higher of the
  // two scores at that version, below for the lower, so crossing lines don't print over each other.
  const sideLabel =
    (key: "security" | "task", fill: string) =>
    (props: { x?: number | string; y?: number | string; index?: number; value?: unknown }) => {
      const d = props.index === undefined ? undefined : data[props.index];
      if (!d || props.value === null || props.value === undefined) return null;
      const other = key === "security" ? d.task : d.security;
      const mine = key === "security" ? d.security : d.task;
      const above = other === null || (mine ?? 0) >= other;
      return (
        <text
          x={Number(props.x)}
          y={Number(props.y) + (above ? -10 : 18)}
          textAnchor="middle"
          fill={fill}
          fontSize={11}
        >
          {String(props.value)}
        </text>
      );
    };
  return (
    <div ref={ref} className="w-full min-w-0 overflow-hidden">
      <LineChart
        width={width}
        height={height}
        data={data}
        margin={{ top: 22, right: 24, bottom: 4, left: -8 }}
        accessibilityLayer
      >
        <CartesianGrid vertical={false} stroke={VIZ.grid} strokeDasharray="3 4" />
        <XAxis
          dataKey="version"
          tick={AXIS}
          tickLine={false}
          axisLine={{ stroke: "rgb(255 255 255 / 0.16)" }}
          padding={{ left: 24, right: 24 }}
        />
        <YAxis
          domain={[0, 100]}
          ticks={[0, 25, 50, 75, 100]}
          tick={AXIS}
          axisLine={false}
          tickLine={false}
          width={48}
        />
        <Tooltip
          cursor={{ stroke: "rgb(255 255 255 / 0.16)", strokeDasharray: "3 3" }}
          content={({ active, payload }) => {
            const model = payload?.[0]?.payload?.model as string | undefined;
            const point = model ? byModel.get(model) : undefined;
            return active && point ? <TipCard>{point.tip}</TipCard> : null;
          }}
        />
        <Line
          dataKey="security"
          name="Security"
          stroke={color}
          strokeWidth={2}
          dot={{ r: 4, fill: color, stroke: "#0e1320", strokeWidth: 2 }}
          isAnimationActive={false}
        >
          <LabelList dataKey="security" content={sideLabel("security", INK)} />
        </Line>
        <Line
          dataKey="task"
          name="Task"
          stroke={color}
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={{ r: 4, fill: "#0e1320", stroke: color, strokeWidth: 2 }}
          connectNulls
          isAnimationActive={false}
        >
          <LabelList dataKey="task" content={sideLabel("task", MUTED)} />
        </Line>
      </LineChart>
    </div>
  );
}

/** A model's name with its logo, for tables and lists. */
export function ModelName({ entry, note }: { entry: BondedIndexEntry; note?: ReactNode }) {
  return (
    <span className="flex items-start gap-2">
      <span className="mt-px">
        <ProviderLogo provider={entry.provider} />
      </span>
      <span className="min-w-0">
        <span className="text-ink">{entry.label}</span>
        {note && <span className="block max-w-xs text-[10px] leading-snug text-muted">{note}</span>}
      </span>
    </span>
  );
}

export { DataTable };
