import type { ReactNode } from "react";

/**
 * Shared chart tokens and the plain table every chart offers as its table view. The charts
 * themselves are in index-charts.tsx (Recharts). Colours were validated against the card surface
 * (#0e1320) with the dataviz palette checker. Provider colors are in index-charts.tsx.
 */
export const VIZ = {
  accent: "#3987e5",
  accentSoft: "#86b6ef",
  other: "#5d6679",
  lost: "#d95926",
  overpaid: "#9085e9",
  grid: "rgb(255 255 255 / 0.08)",
} as const;

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
