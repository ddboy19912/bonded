/**
 * Tables in the repo's Markdown, laid out for reading on the site. The Markdown is unchanged
 * (GitHub still shows a table); only the page the site builds differs.
 *
 * - A table with sentences in it becomes a numbered list, one item per row: "1. Name: text".
 *   The first cell is the name; the second follows it (with its column's name when it is a short
 *   value rather than text); any further cells follow in the table's order as "Column: value",
 *   so nothing is dropped.
 * - A table of short values (addresses, numbers, ids) stays a table, wrapped so a wide one
 *   scrolls on its own.
 */

/** A column whose cells average this many words is prose, not data. */
export const PROSE_WORDS = 5;

const el = (tagName, className, children = []) => ({
  type: "element",
  tagName,
  properties: className ? { className: [className] } : {},
  children,
});

const kids = (node, tag) =>
  (node.children ?? []).filter((c) => c.type === "element" && c.tagName === tag);

/** All the text inside a node, for measuring. */
export function textOf(node) {
  if (node.type === "text") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

/** The header cells and body rows of a table, as arrays of cell nodes. */
function parts(table) {
  const head = kids(table, "thead").flatMap((t) => kids(t, "tr"))[0];
  const body = [...kids(table, "tbody"), table].flatMap((t) => kids(t, "tr"));
  const headers = head ? kids(head, "th") : [];
  const rows = body.map((tr) => [...kids(tr, "td"), ...kids(tr, "th")]).filter((r) => r.length);
  return { headers, rows };
}

const words = (node) =>
  textOf(node ?? { type: "text", value: "" })
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

/** Which layout a table gets: "list" (it has sentences in it) or "table". */
export function layoutOf(table) {
  const { headers, rows } = parts(table);
  const cols = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  if (!rows.length || cols < 2) return "table";
  for (let c = 0; c < cols; c++) {
    const avg = rows.reduce((n, r) => n + words(r[c]), 0) / rows.length;
    if (avg >= (c === 0 ? PROSE_WORDS + 3 : PROSE_WORDS)) return "list";
  }
  return "table";
}

/** A row's name: its first cell, with the column's name in front when the cell is only a number. */
function nameOf(cell, column) {
  const text = textOf(cell ?? { type: "text", value: "" }).trim();
  return column && /^[0-9]{1,3}$/.test(text)
    ? [{ type: "text", value: `${column} ${text}` }]
    : (cell?.children ?? []);
}

const t = (value) => ({ type: "text", value });

function asList(table) {
  const { headers, rows } = parts(table);
  const names = headers.map((h) => textOf(h).trim());
  // The second column follows the name bare when it is the row's text (prose); a short value
  // there (a code, a score) keeps its column's name so it still reads.
  const prose = rows.reduce((n, r) => n + words(r[1]), 0) / rows.length >= PROSE_WORDS;
  return el(
    "ol",
    "bn-olist",
    rows.map((cells) => {
      const body = [];
      cells.slice(1).forEach((cell, i) => {
        if (!textOf(cell).trim()) return;
        if (body.length) {
          // A new sentence after the last one, without doubling its full stop.
          const before = textOf({ children: body }).trimEnd();
          body.push(t(/[.!?:;]$/.test(before) ? " " : ". "));
        }
        const label = i > 0 || !prose ? names[i + 1] : "";
        if (label) body.push(t(`${label}: `));
        body.push(...(cell.children ?? []));
      });
      return el("li", null, [
        el("strong", null, nameOf(cells[0], names[0])),
        ...(body.length ? [t(": "), ...body] : []),
      ]);
    }),
  );
}

export default function rehypeTables() {
  const walk = (node) => {
    if (!node.children) return;
    node.children = node.children.map((child) => {
      if (child.type === "element" && child.tagName === "table") {
        const layout = layoutOf(child);
        if (layout === "list") return asList(child);
        return el("div", "table-wrap", [child]);
      }
      walk(child);
      return child;
    });
  };
  return walk;
}
