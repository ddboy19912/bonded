import type { ToolCall } from "@bondedhq/shared";

/**
 * Reads tool calls a model wrote as text, in the pythonic list form Llama models use:
 *
 *   I'll start with the queue. [list_approved_invoices(), get_vendor(vendorId="acme")]
 *
 * Providers turn that into real tool calls only when the reply holds nothing else, so a reply
 * with a sentence before it reaches the agent as plain text, and a loop that treats text as
 * "finished" ends the run before the model has acted. This is the same adapter inference servers
 * ship for Llama (vLLM's pythonic tool parser), kept strict:
 *
 * - only the first bracketed list is read, and only if every call in it names one of the
 *   agent's tools and its arguments parse as keyword literals; anything else returns null;
 * - whatever the model wrote after that list is dropped. Llama sometimes goes on to invent the
 *   call's result; running only the leading calls, and handing back the real results, keeps the
 *   run honest.
 */
export interface TextToolCalls {
  /** What the model wrote before the calls, kept as the assistant's text. */
  before: string;
  calls: ToolCall[];
}

export function readTextToolCalls(
  text: string | null | undefined,
  toolNames: ReadonlySet<string>,
  idPrefix = "text-call",
): TextToolCalls | null {
  if (!text) return null;
  const start = text.search(/\[\s*[A-Za-z_][\w]*\s*\(/);
  if (start < 0) return null;
  const parsed = parseCallList(text, start);
  if (!parsed || parsed.calls.length === 0) return null;
  if (!parsed.calls.every((c) => toolNames.has(c.name))) return null;
  return {
    before: text.slice(0, start).trim(),
    calls: parsed.calls.map((c, i) => ({
      id: `${idPrefix}-${i}`,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  };
}

type Literal = string | number | boolean | null;

/** Parses `[name(k=v, ...), ...]` from `start`; null on anything it doesn't recognise. */
function parseCallList(
  text: string,
  start: number,
): { calls: { name: string; args: Record<string, Literal> }[]; end: number } | null {
  let i = start + 1;
  const calls: { name: string; args: Record<string, Literal> }[] = [];
  const skip = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const ident = () => {
    const m = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  for (;;) {
    skip();
    const name = ident();
    if (!name) return null;
    skip();
    if (text[i] !== "(") return null;
    i++;
    const args: Record<string, Literal> = {};
    skip();
    while (text[i] !== ")") {
      skip();
      const key = ident();
      if (!key) return null;
      skip();
      if (text[i] !== "=") return null;
      i++;
      skip();
      const value = literal();
      if (value === undefined) return null;
      args[key] = value;
      skip();
      if (text[i] === ",") {
        i++;
        skip();
      } else if (text[i] !== ")") return null;
    }
    i++;
    calls.push({ name, args });
    skip();
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] === "]") return { calls, end: i + 1 };
    return null;
  }

  /** A quoted string, a number, a boolean, null/None, or a bare word up to `,` or `)`. */
  function literal(): Literal | undefined {
    const q = text[i];
    if (q === '"' || q === "'") {
      let out = "";
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === "\\" && i + 1 < text.length) i++;
        out += text[i];
        i++;
      }
      if (text[i] !== q) return undefined;
      i++;
      return out;
    }
    const m = /^[^,)\]\n]+/.exec(text.slice(i));
    if (!m) return undefined;
    i += m[0].length;
    const raw = m[0].trim();
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (/^(true|True)$/.test(raw)) return true;
    if (/^(false|False)$/.test(raw)) return false;
    if (/^(null|None)$/.test(raw)) return null;
    // Nested lists, dicts or calls aren't arguments this reader takes.
    if (/[[\]{}()=]/.test(raw) || raw === "") return undefined;
    return raw;
  }
}
