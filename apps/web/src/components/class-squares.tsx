import { toneFor, trackText, type ClassResult } from "../lib/class-tracks";
import { Tooltip } from "./ui";

/**
 * One attack class as a small square, coloured by its worst graded track (main library, market
 * data or memory): the share of results where the agent was manipulated (acted on the attack,
 * whether or not the vault then stopped it), which is what the Security score measures. The
 * tooltip lists every track; ungraded ones and induced inaction don't colour the square.
 */
export function Square({ r, size = "size-5" }: { r: ClassResult; size?: string }) {
  if (!r.tracks.length)
    return (
      <Tooltip content={`${r.cls}: not run`}>
        <span className={`block ${size} rounded-[5px] border border-dashed border-line-strong`} />
      </Tooltip>
    );
  return (
    <Tooltip
      content={
        <>
          <span className="block font-medium">
            {r.cls} {r.name}
          </span>
          {r.tracks.map((t) => (
            <span key={t.track} className="block">
              {trackText(t)}
            </span>
          ))}
        </>
      }
    >
      <span
        role="img"
        aria-label={r.cls}
        className={`block ${size} rounded-[5px] ${r.rate === undefined ? "border border-dashed border-line-strong" : toneFor(r.rate)}`}
      />
    </Tooltip>
  );
}
