import { useRef, useState, type ReactNode } from "react";

/**
 * Small chart pieces for the Bonded Index, drawn in HTML and SVG with the app's tokens. The
 * conventions follow the dataviz method: thin marks with 4px rounded data-ends, hairline grids,
 * a 2px surface gap between touching fills, a legend for two or more series, text in ink tokens
 * (never the series colour), a hover/focus tooltip on every mark, and a table view for every
 * chart. Colours were validated against the card surface (#0e1320) with the palette checker.
 */
export const VIZ = {
  accent: "#3987e5",
  accentSoft: "#86b6ef",
  other: "#5d6679",
  lost: "#d95926",
  overpaid: "#9085e9",
  grid: "rgb(255 255 255 / 0.08)",
} as const;

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

/** A tooltip layer: `bind(content, label)` gives a mark hover and keyboard focus props. */
export function useTip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const place = (clientX: number, clientY: number, content: ReactNode) => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setTip({ x: clientX - box.left, y: clientY - box.top, content });
  };
  const bind = (content: ReactNode, label: string) => ({
    tabIndex: 0,
    role: "img",
    "aria-label": label,
    onPointerEnter: (e: React.PointerEvent) => place(e.clientX, e.clientY, content),
    onPointerMove: (e: React.PointerEvent) => place(e.clientX, e.clientY, content),
    onPointerLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent<Element>) => {
      const r = e.currentTarget.getBoundingClientRect();
      place(r.left + r.width / 2, r.top, content);
    },
    onBlur: () => setTip(null),
  });
  const layer = tip && (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-20 w-max max-w-64 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-lg border border-line-strong bg-raised px-3 py-2 text-xs text-soft shadow-(--shadow-raised)"
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.content}
    </div>
  );
  return { ref, bind, layer };
}

/** A tooltip row: a short line key in the series colour, the value strong, the name after. */
export function TipRow({ color, value, name }: { color?: string; value: ReactNode; name: string }) {
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      {color && <span className="h-0.5 w-3 rounded-full" style={{ background: color }} />}
      <strong className="font-semibold text-ink">{value}</strong>
      <span className="text-muted">{name}</span>
    </span>
  );
}

export function Legend({
  items,
}: {
  items: { color: string; label: string; shape?: "dot" | "bar" }[];
}) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span
            className={i.shape === "dot" ? "size-2.5 rounded-full" : "h-2.5 w-3 rounded-[2px]"}
            style={{ background: i.color }}
          />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** A chart card: title, one-line caption, the chart, and a switch to its table view. */
export function ChartFrame({
  title,
  caption,
  legend,
  table,
  children,
}: {
  title: string;
  caption: ReactNode;
  legend?: ReactNode;
  table: ReactNode;
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className="panel flex min-w-0 flex-col gap-4 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-semibold text-ink">{title}</h2>
          <figcaption className="mt-1 text-sm text-muted">{caption}</figcaption>
        </div>
        <button
          type="button"
          onClick={() => setAsTable((t) => !t)}
          aria-pressed={asTable}
          className="shrink-0 rounded-full border border-line-strong px-3 py-1 text-xs text-muted hover:text-ink"
        >
          {asTable ? "Chart" : "Table"}
        </button>
      </div>
      {!asTable && legend}
      {asTable ? <div className="overflow-x-auto">{table}</div> : children}
    </figure>
  );
}

/** A plain data table for a chart's table view. */
export function DataTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-muted">
        <tr>
          {head.map((h) => (
            <th key={h} className="border-b border-line py-2 pr-4 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="tabular-nums text-soft">
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className="border-b border-line py-2 pr-4">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Horizontal rows: a label column and a 0-to-`max` track. Shared by the bar-style charts. */
export function Rows({
  rows,
  max,
  ticks,
  format,
}: {
  rows: { key: string; label: ReactNode; track: (scale: (v: number) => string) => ReactNode }[];
  max: number;
  ticks: number[];
  format: (v: number) => string;
}) {
  const scale = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  return (
    // The right padding leaves room for a value label past the end of a full-length bar.
    <div className="grid grid-cols-[minmax(6.5rem,9rem)_1fr] gap-x-3 gap-y-2.5 pr-12 text-xs">
      {rows.map((r) => (
        <div key={r.key} className="contents">
          <div className="truncate self-center text-soft">{r.label}</div>
          <div className="relative h-5">
            {ticks.map((t) => (
              <span
                key={t}
                aria-hidden
                className="absolute inset-y-0 w-px"
                style={{ left: scale(t), background: VIZ.grid }}
              />
            ))}
            {r.track(scale)}
          </div>
        </div>
      ))}
      <div />
      <div className="relative h-4 text-[11px] text-muted tabular-nums">
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2" style={{ left: scale(t) }}>
            {format(t)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A point on a scatter: models that land on the same spot share one labelled point. */
export interface ScatterPoint {
  key: string;
  x: number;
  y: number;
  label: string;
  emphasis: boolean;
  tip: ReactNode;
}

export function Scatter({
  points,
  x,
  y,
  bind,
}: {
  points: ScatterPoint[];
  x: {
    min: number;
    max: number;
    ticks: number[];
    format: (v: number) => string;
    label: string;
    log?: boolean;
  };
  y: { min: number; max: number; ticks: number[]; format: (v: number) => string; label: string };
  bind: ReturnType<typeof useTip>["bind"];
}) {
  const W = 640;
  const H = 320;
  const pad = { l: 44, r: 24, t: 16, b: 40 };
  const tx = (v: number) => {
    const f = x.log
      ? (Math.log10(v) - Math.log10(x.min)) / (Math.log10(x.max) - Math.log10(x.min))
      : (v - x.min) / (x.max - x.min);
    return pad.l + Math.max(0, Math.min(1, f)) * (W - pad.l - pad.r);
  };
  const ty = (v: number) =>
    H - pad.b - Math.max(0, Math.min(1, (v - y.min) / (y.max - y.min))) * (H - pad.t - pad.b);
  // Merge points that would overlap, so identical results read as one labelled point.
  const groups: { x: number; y: number; members: ScatterPoint[] }[] = [];
  for (const p of points) {
    const g = groups.find((g) => Math.hypot(tx(g.x) - tx(p.x), ty(g.y) - ty(p.y)) < 10);
    if (g) g.members.push(p);
    else groups.push({ x: p.x, y: p.y, members: [p] });
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full overflow-visible" role="group">
      {y.ticks.map((t) => (
        <g key={`y${t}`}>
          <line x1={pad.l} x2={W - pad.r} y1={ty(t)} y2={ty(t)} stroke={VIZ.grid} />
          <text
            x={pad.l - 8}
            y={ty(t)}
            dy="0.32em"
            textAnchor="end"
            className="fill-muted text-[11px]"
          >
            {y.format(t)}
          </text>
        </g>
      ))}
      {x.ticks.map((t) => (
        <text
          key={`x${t}`}
          x={tx(t)}
          y={H - pad.b + 18}
          textAnchor="middle"
          className="fill-muted text-[11px]"
        >
          {x.format(t)}
        </text>
      ))}
      <text
        x={(pad.l + W - pad.r) / 2}
        y={H - 4}
        textAnchor="middle"
        className="fill-muted text-[11px]"
      >
        {x.label}
      </text>
      <text
        transform={`translate(12 ${(pad.t + H - pad.b) / 2}) rotate(-90)`}
        textAnchor="middle"
        className="fill-muted text-[11px]"
      >
        {y.label}
      </text>
      {groups.map((g) => {
        const emphasis = g.members.some((m) => m.emphasis);
        const label = g.members.map((m) => m.label).join(", ");
        const cx = tx(g.x);
        const anchorEnd = cx > W * 0.66;
        return (
          <g key={g.members.map((m) => m.key).join("|")}>
            <g
              {...bind(
                <span className="flex flex-col gap-1">
                  {g.members.map((m) => (
                    <span key={m.key}>{m.tip}</span>
                  ))}
                </span>,
                label,
              )}
              className="cursor-default outline-none [&:focus-visible>circle:last-child]:stroke-ink"
            >
              <circle cx={cx} cy={ty(g.y)} r={12} fill="transparent" />
              <circle
                cx={cx}
                cy={ty(g.y)}
                r={5}
                fill={emphasis ? VIZ.accent : VIZ.other}
                stroke="#0e1320"
                strokeWidth={2}
              />
            </g>
            <text
              x={cx + (anchorEnd ? -10 : 10)}
              y={ty(g.y)}
              dy="0.32em"
              textAnchor={anchorEnd ? "end" : "start"}
              className="pointer-events-none fill-soft text-[11px]"
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
