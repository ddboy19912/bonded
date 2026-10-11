import { Fragment, useId, type ReactNode } from "react";
import { Highlight, Prism, type PrismTheme } from "prism-react-renderer";
import { CopyButton } from "./copy-button";

export type CodeLanguage = "bash" | "sh" | "ts" | "python" | "json" | "yaml";

/**
 * prism-react-renderer ships no shell grammar: commands (also after `KEY=value`), builtins, flags,
 * variables, strings, comments, and the plain words in between as arguments. Order matters: a
 * command is found first, and the assignments in front of it stay for the later rules.
 */
if (!Prism.languages.bash) {
  Prism.languages.bash = {
    comment: { pattern: /(^|\s)#.*/, lookbehind: true, greedy: true },
    string: { pattern: /"(?:\\.|[^"\\])*"|'[^']*'/, greedy: true },
    "builtin-command": {
      pattern: /(^|&&\s*|\|\|\s*|\|\s*|;\s*)(?:cd|export|source|echo|exit|set|unset)\b/m,
      lookbehind: true,
    },
    function: {
      pattern:
        /(^|&&\s*|\|\|\s*|\|\s*|;\s*)(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:sudo\s+)?[A-Za-z][\w.-]*/m,
      lookbehind: true,
      inside: {
        // The assignments in front of the command: the name, an equals sign, the value.
        assign: {
          pattern: /\b[A-Z_][A-Z0-9_]*=\S*/,
          alias: "argument",
          inside: { variable: /^[^=]+/, "shell-operator": /=/ },
        },
        function: /[A-Za-z][\w.-]*$/,
      },
    },
    variable: [{ pattern: /\$\{?[A-Za-z_]\w*\}?/ }, { pattern: /\b[A-Z_][A-Z0-9_]*(?==)/ }],
    "shell-flag": { pattern: /(^|\s)--?[A-Za-z][\w-]*/, lookbehind: true },
    "shell-operator": /&&|\|\||[|;=]/,
    argument: /[^\s&|;]+/,
  };
}

const PRISM_LANGUAGE: Record<CodeLanguage, string> = {
  bash: "bash",
  sh: "bash",
  ts: "tsx",
  python: "python",
  json: "json",
  yaml: "yaml",
};

/** The docs' code colours (Expressive Code's Night Owl): tan strings, blue commands, green builtins. */
const NIGHT_OWL: PrismTheme = {
  plain: { color: "#d6deeb", backgroundColor: "transparent" },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: { color: "#637777", fontStyle: "italic" },
    },
    { types: ["punctuation"], style: { color: "#d6deeb" } },
    { types: ["operator", "tag", "selector"], style: { color: "#7fdbca" } },
    { types: ["keyword", "atom", "important"], style: { color: "#c792ea" } },
    { types: ["boolean"], style: { color: "#ff5874" } },
    {
      types: ["string", "char", "attr-value", "template-string", "regex", "argument", "url"],
      style: { color: "#ecc48d" },
    },
    { types: ["number", "symbol"], style: { color: "#f78c6c" } },
    { types: ["function", "builtin", "constant", "shell-flag"], style: { color: "#82aaff" } },
    { types: ["class-name", "maybe-class-name"], style: { color: "#ffcb8b" } },
    { types: ["property", "attr-name", "parameter", "namespace"], style: { color: "#7fdbca" } },
    { types: ["builtin-command"], style: { color: "#addb67" } },
    { types: ["variable"], style: { color: "#d7dbe0" } },
  ],
};

/**
 * Code to read and copy, framed as in the docs: a header bar (three dots, and the block's name),
 * the code in the docs' colours, and a small copy button in the corner. Code scrolls sideways
 * rather than breaking in the middle of a word; a shell command wraps, since it is one long line.
 */
export function CodeBlock({
  code,
  language = "bash",
  label,
}: {
  code: string;
  language?: CodeLanguage;
  label: ReactNode;
}) {
  const id = useId();
  const wrap = language === "bash" || language === "sh";
  return (
    <figure
      data-language={language}
      className="overflow-hidden rounded-[0.9rem] border border-line bg-[#0a0e17] shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]"
    >
      <figcaption className="flex h-9 items-center gap-3 border-b border-line bg-black/30 px-4">
        <span className="flex shrink-0 gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-white/[0.09]" />
          <span className="size-2.5 rounded-full bg-white/[0.09]" />
          <span className="size-2.5 rounded-full bg-white/[0.09]" />
        </span>
        <span id={id} className="min-w-0 truncate text-xs text-muted">
          {label}
        </span>
      </figcaption>
      <div className="relative">
        <Highlight
          theme={NIGHT_OWL}
          code={code.replace(/\n$/, "")}
          language={PRISM_LANGUAGE[language]}
        >
          {({ tokens, getLineProps, getTokenProps }) => (
            <pre
              aria-labelledby={id}
              tabIndex={0}
              className={`py-4 pr-14 pl-4 font-mono text-[13.5px] leading-[1.75] focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset ${wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto whitespace-pre"}`}
            >
              <code>
                {tokens.map((line, i) => (
                  <div key={i} {...getLineProps({ line })}>
                    {line.map((token, j) => (
                      <span key={j} {...getTokenProps({ token })} />
                    ))}
                    {line.length === 0 && "\n"}
                  </div>
                ))}
              </code>
            </pre>
          )}
        </Highlight>
        <div className="absolute top-2 right-2">
          <CopyButton text={code} variant="icon" />
        </div>
      </div>
    </figure>
  );
}

/** A path, command, flag or identifier in running text. */
export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md bg-white/[0.08] px-1.5 py-0.5 font-mono text-[0.86em] break-words text-soft">
      {children}
    </code>
  );
}

/**
 * Text with `code` in backticks: the parts between them are shown as inline code, the rest as is.
 * Plain strings stay plain; a lone backtick is left alone.
 */
export function Rich({ children }: { children: string }) {
  const parts = children.split(/`([^`]+)`/);
  if (parts.length === 1) return <>{children}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <InlineCode key={i}>{part}</InlineCode> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}
