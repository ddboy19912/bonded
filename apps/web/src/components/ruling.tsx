import type { RulingTone, RulingView } from "../lib/ruling";
import { Badge } from "./ui";

/** A ruling's colours: orange for a breach, blue for a defence, grey for "nothing to learn". */
const DOT: Record<RulingTone, string> = {
  breach: "bg-breach-solid",
  held: "bg-brand-bright",
  muted: "bg-[#4a4f59]",
};
const BADGE: Record<RulingTone, "breach" | "brand" | "neutral"> = {
  breach: "breach",
  held: "brand",
  muted: "neutral",
};
/** The verdict's bar at its left and the colour of its headline. */
const VERDICT: Record<RulingTone, { bar: string; text: string }> = {
  breach: { bar: "border-breach-solid", text: "text-breach-solid" },
  held: { bar: "border-brand-bright", text: "text-accent" },
  muted: { bar: "border-line-strong", text: "text-soft" },
};

export const RulingDot = ({ r }: { r: RulingView }) => (
  <span className={`size-2 rounded-full ${DOT[r.tone]}`} />
);

/** A ruling as a coloured word, for a feed row: the verdict read at a glance, no box around it. */
export const RulingWord = ({ r }: { r: RulingView }) => (
  <span
    className={`text-[15px] leading-none font-medium tracking-[-0.02em] whitespace-nowrap ${VERDICT[r.tone].text}`}
  >
    {r.pill}
  </span>
);

export const RulingBadge = ({ r }: { r: RulingView }) => (
  <Badge tone={BADGE[r.tone]}>{r.pill}</Badge>
);

/** The verdict: the ruling in large type with a coloured bar at its left, and one line on why. */
export function VerdictCard({ r }: { r: RulingView }) {
  return (
    <div className={`border-l-2 pl-5 ${VERDICT[r.tone].bar}`}>
      <p
        className={`text-[clamp(30px,3.4vw,46px)] leading-[0.95] font-medium tracking-[-0.05em] ${VERDICT[r.tone].text}`}
      >
        {r.title}
      </p>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-soft">{r.why}</p>
    </div>
  );
}
