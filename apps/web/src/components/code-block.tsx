import { Fragment, useId, type ReactNode } from "react";
import { Highlight, Prism, type PrismTheme } from "prism-react-renderer";
import { CopyButton } from "./copy-button";

export type CodeLanguage = "bash" | "sh" | "ts" | "python" | "json" | "yaml";

/** prism-react-renderer ships no shell grammar: commands, flags, variables, strings and comments. */
if (!Prism.languages.bash) {
  // Order matters: a command is found first (it may follow variable assignments, which stay for
  // the later rules), then the assignments, flags and operators around it.
  Prism.languages.bash = {
    comment: { pattern: /(^|\s)#.*/, lookbehind: true, greedy: true },
    string: { pattern: /"(?:\\.|[^"\\])*"|'[^']*'/, greedy: true },
    function: {
      pattern:
        /(^|&&\s*|\|\|\s*|\|\s*|;\s*)(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:sudo\s+)?[A-Za-z][\w.-]*/m,
      lookbehind: true,
      inside: {
        // The assignments in front of the command: the name, an equals sign, the value.
        assign: {
          pattern: /\b[A-Z_][A-Z0-9_]*=\S*/,
          alias: "string",
          inside: { variable: /^[^=]+/, operator: /=/ },
        },
        function: /[A-Za-z][\w.-]*$/,
      },
    },
    variable: [{ pattern: /\$\{?[A-Za-z_]\w*\}?/ }, { pattern: /\b[A-Z_][A-Z0-9_]*(?==)/ }],
    parameter: { pattern: /(^|\s)--?[A-Za-z][\w-]*/, lookbehind: true },
    operator: /&&|\|\||[|;=]/,
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
const LANGUAGE_LABEL: Record<CodeLanguage, string> = {
  bash: "Shell",
  sh: "Shell",
  ts: "TypeScript",
  python: "Python",
  json: "JSON",
  yaml: "YAML",
};

/** The Aurora palette for code, as in the attack-spec editor: keys blue, strings warm, numbers green. */
const AURORA: PrismTheme = {
  plain: { color: "#e6ebf7", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: { color: "#6b758b" } },
    { types: ["punctuation", "operator"], style: { color: "#8d96ab" } },
    { types: ["keyword", "boolean", "atom", "selector", "important"], style: { color: "#ff9a80" } },
    {
      types: ["string", "char", "attr-value", "template-string", "regex"],
      style: { color: "#ffcf9e" },
    },
    { types: ["number", "constant", "symbol", "builtin"], style: { color: "#7ee2b0" } },
    {
      types: ["function", "class-name", "tag", "property", "attr-name", "parameter"],
      style: { color: "#afc4ff" },
    },
    { types: ["variable", "maybe-class-name", "namespace"], style: { color: "#d7dffa" } },
  ],
};

/**
 * Code to read and copy: a header with its name, language and a copy button, then the code
 * highlighted in the app's palette. Code scrolls sideways rather than breaking in the middle of a
 * word; a shell command wraps, since it is one long line.
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
    <div className="overflow-hidden rounded-xl border border-line bg-black/40">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-white/[0.03] py-1.5 pr-2 pl-4">
        <span id={id} className="min-w-0 truncate text-xs font-semibold text-soft">
          {label}
        </span>
        <span className="flex shrink-0 items-center gap-2.5">
          <span className="text-[11px] tracking-wide text-muted uppercase">
            {LANGUAGE_LABEL[language]}
          </span>
          <CopyButton text={code} />
        </span>
      </div>
      <Highlight theme={AURORA} code={code.replace(/\n$/, "")} language={PRISM_LANGUAGE[language]}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre
            aria-labelledby={id}
            tabIndex={0}
            className={`p-4 font-mono text-[13px] leading-6 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto whitespace-pre"}`}
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
    </div>
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
