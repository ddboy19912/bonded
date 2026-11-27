/** The sidebar's icons, as SVG paths on a 24-unit grid (also used by search). */
export const ICONS = {
  overview: "M3 3h8v10H3zM13 3h8v6h-8zM13 11h8v10h-8zM3 15h8v6H3z",
  agents: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  leaderboard: "M4 21h16M7 21V12M12 21V6M17 21v-5",
  index: "M4 19l5-6 4 3 7-9M4 4v15h16",
  arena: "M5 12a7 7 0 1 0 14 0a7 7 0 1 0-14 0M12 2v5M12 17v5M2 12h5M17 12h5",
  vaults: "M4 5h16v14H4zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M4 9h2M4 15h2",
  mine: "M12 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8M4 21c0-4 4-6 8-6s8 2 8 6",
  deposits: "M3 7h18v12H3zM16 13h2M6 7l3-3h9l1 3",
  pool: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5",
  claims: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  bounties: "M5 21V4h11l-2 4 2 4H5",
  redteam: "M12 3l8 3v6c0 5-3.5 8-8 9c-4.5-1-8-4-8-9V6zM9 10l6 6M15 10l-6 6",
  sentinel: "M12 3l8 3v6c0 5-3.5 8-8 9c-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5",
  docs: "M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM8 7h8M8 11h6",
  gate: "M3 10l9-6 9 6M5 10v9M19 10v9M9.5 10v9M14.5 10v9M3 20h18",
  test: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 9l2 2 4-4M9 15h6",
  chevron: "M9 6l6 6-6 6",
} as const;

/** One of those icons, stroked in the current colour. */
export function Icon({ d, className = "size-[18px]" }: { d: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}
