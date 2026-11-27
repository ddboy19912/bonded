import { Fragment, type ReactNode } from "react";
import { TOKEN_MARKS, splitTokens } from "../lib/tokens";

/** A token's logo on a disc, falling back to its first letter. */
export function TokenLogo({ symbol, size = 20 }: { symbol: string; size?: number | string }) {
  const mark = TOKEN_MARKS[symbol];
  const box = { width: size, height: size };
  if (mark?.img) return <img src={mark.img} alt="" className="shrink-0 rounded-full" style={box} />;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full"
      style={{ ...box, background: mark?.bg ?? "#26282d" }}
      aria-hidden
    >
      {mark?.path ? (
        <svg viewBox="0 0 24 24" className="h-[60%] w-[60%]">
          <path d={mark.path} fill={mark.fg} />
        </svg>
      ) : (
        <span className="text-[10px] font-bold">{symbol.replace(/^t/, "").slice(0, 1)}</span>
      )}
    </span>
  );
}

/** A token symbol in running text, with its logo beside it. */
export function Token({ symbol }: { symbol: string }) {
  return (
    <span className="inline-flex items-center gap-[0.3em] whitespace-nowrap align-[-0.2em]">
      <TokenLogo symbol={symbol} size="1.15em" />
      {symbol}
    </span>
  );
}

/** Text with every token symbol in it drawn with its logo. */
export function withTokens(text: string): ReactNode {
  return splitTokens(text).map((part, i) => (
    <Fragment key={i}>{part.token ? <Token symbol={part.text} /> : part.text}</Fragment>
  ));
}

/** A token as an outlined tag: logo and symbol. */
export function TokenChip({ symbol }: { symbol: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line-strong py-1 pr-3 pl-1 font-mono text-xs text-soft">
      <TokenLogo symbol={symbol} />
      {symbol}
    </span>
  );
}
