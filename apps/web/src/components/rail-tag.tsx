import { RAIL_HINT, RAIL_LABEL, type Rail } from "../lib/rails";

/** A small label naming the payment rail a row or report was rated on. */
export function RailTag({ rail }: { rail: Rail }) {
  return (
    <span
      title={RAIL_HINT[rail]}
      className="inline-flex shrink-0 items-center rounded-full border border-line-strong px-2 py-px text-[10.5px] whitespace-nowrap text-soft"
    >
      {RAIL_LABEL[rail]}
    </span>
  );
}
