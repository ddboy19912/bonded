import type { ReactNode } from "react";

/**
 * Shared chart tokens and the plain table every chart offers as its table view. The charts
 * themselves are in index-charts.tsx (Recharts). The palette is the app's own: one blue for the
 * measure, orange for money lost to an attack, amber for overpaid, and greys for the rest, all on
 * the near-black page (#07080a).
 */
export const VIZ = {
  accent: "#3c6bff",
  accentSoft: "#9db5ff",
  /** The second measure beside Security (Task), as on the Overview's ledger. */
  ink: "#c9ccd3",
  other: "#5d626d",
  lost: "#ff7a45",
  overpaid: "#ffb347",
  grid: "rgb(255 255 255 / 0.07)",
} as const;

/** A plain data table for a chart's table view: mono column names and hairlines between rows. */
export function DataTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <table className="w-full text-left text-[13px]">
      <thead>
        <tr>
          {head.map((h) => (
            <th
              key={h}
              className="border-b border-line pr-4 pb-2.5 font-mono text-[12px] font-normal text-muted"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="tabular-nums text-soft">
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className="border-b border-line py-3 pr-4">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
