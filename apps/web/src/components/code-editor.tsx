import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { yaml } from "@codemirror/lang-yaml";
import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";

/** The Aurora palette for code: keys in brand blue, strings warm, numbers green. */
const aurora = createTheme({
  theme: "dark",
  settings: {
    background: "transparent",
    foreground: "#e6ebf7",
    caret: "#afc4ff",
    selection: "rgb(60 107 255 / 0.35)",
    selectionMatch: "rgb(60 107 255 / 0.2)",
    lineHighlight: "rgb(255 255 255 / 0.03)",
    gutterBackground: "transparent",
    gutterForeground: "#4d566a",
    gutterBorder: "transparent",
    fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace',
  },
  styles: [
    { tag: [t.propertyName, t.definition(t.propertyName), t.attributeName], color: "#afc4ff" },
    { tag: [t.string, t.special(t.string)], color: "#ffcf9e" },
    { tag: [t.number, t.bool, t.null], color: "#7ee2b0" },
    { tag: [t.comment, t.lineComment], color: "#5f687c", fontStyle: "italic" },
    { tag: [t.punctuation, t.separator, t.bracket], color: "#8d96ab" },
    { tag: [t.keyword, t.atom], color: "#ff9a80" },
  ],
});

/**
 * A code editor with line numbers and syntax colours: YAML for attack specs (the default), or
 * JavaScript and TypeScript for an agent Bonded runs.
 */
export function CodeEditor({
  value,
  onChange,
  placeholder,
  invalid,
  label,
  language = "yaml",
  minHeight = "300px",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
  label: string;
  language?: "yaml" | "js" | "ts";
  minHeight?: string;
}) {
  return (
    <div className={`overflow-hidden ${invalid ? "ring-1 ring-breach/50" : ""}`}>
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={aurora}
        extensions={[language === "yaml" ? yaml() : javascript({ typescript: language === "ts" })]}
        placeholder={placeholder}
        minHeight={minHeight}
        maxHeight="480px"
        aria-label={label}
        basicSetup={{ foldGutter: false, highlightActiveLineGutter: true, autocompletion: false }}
        className="text-[13px] [&_.cm-content]:py-4 [&_.cm-editor]:outline-none [&_.cm-placeholder]:text-muted/70"
      />
    </div>
  );
}
