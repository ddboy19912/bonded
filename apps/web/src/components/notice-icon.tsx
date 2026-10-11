import type { NoticeIconName, NoticeTone } from "../lib/notification-kinds";

const PATHS: Record<NoticeIconName, string> = {
  check: "M20 6 9 17l-5-5",
  stop: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM15 9l-6 6M9 9l6 6",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2",
  plug: "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5",
  fuel: "M12 22a7 7 0 0 0 7-7c0-5-7-13-7-13S5 10 5 15a7 7 0 0 0 7 7Z",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM12 8v4M12 16h.01",
  claim: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M8 13h8M8 17h6",
  paid: "M3 6h18v12H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 12h.01M18 12h.01",
  umbrella: "M22 12a10 10 0 0 0-20 0h20ZM12 12v7a2 2 0 0 0 4 0",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9ZM13.7 21a2 2 0 0 1-3.4 0",
};

const TONE: Record<NoticeTone | "neutral", string> = {
  safe: "bg-safe-soft text-safe",
  warn: "bg-warn-soft text-warn",
  breach: "bg-breach-soft text-breach",
  neutral: "bg-white/[0.07] text-muted",
};

/** A notification's icon in a soft circle, coloured by how it reads (good, to do, wrong). */
export function NoticeIcon({
  icon = "bell",
  tone,
}: {
  icon?: NoticeIconName;
  tone?: NoticeTone | undefined;
}) {
  return (
    <span
      aria-hidden
      className={`flex size-9 shrink-0 items-center justify-center rounded-full ${TONE[tone ?? "neutral"]}`}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-[18px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={PATHS[icon]} />
      </svg>
    </span>
  );
}
