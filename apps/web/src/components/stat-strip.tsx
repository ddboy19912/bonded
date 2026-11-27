import type { ReactNode } from "react";
import { Spinner } from "./ui";

/** A stat that's still loading: a small spinner where the number will be. */
export function StatLoading() {
  return (
    <span className="inline-flex h-10 items-center text-muted" role="status">
      <Spinner />
      <span className="sr-only">Loading…</span>
    </span>
  );
}

/**
 * A row of key numbers in the open: each a mono label, a big number and a short line, with a
 * hairline above. No panel around them and no box per number.
 */
export function StatStrip({
  stats,
}: {
  stats: { label: ReactNode; value: ReactNode; hint?: ReactNode }[];
}) {
  return (
    <section className="grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
      {stats.map((t, i) => (
        <div key={i} className="min-w-0 border-t border-line pt-4">
          <p className="eyebrow">{t.label}</p>
          <p className="num-big mt-3 truncate pb-[0.1em] lg:text-[clamp(40px,4vw,60px)]">
            {t.value}
          </p>
          {t.hint && <p className="mt-2.5 text-[13px] text-muted">{t.hint}</p>}
        </div>
      ))}
    </section>
  );
}
