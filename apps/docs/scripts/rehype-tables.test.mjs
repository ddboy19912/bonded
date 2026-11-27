import assert from "node:assert/strict";
import { test } from "node:test";
import rehypeTables, { layoutOf, textOf } from "./rehype-tables.mjs";

const t = (value) => ({ type: "text", value });
const cell = (tag, s) => ({ type: "element", tagName: tag, properties: {}, children: [t(s)] });
const tr = (tag, cells) => ({
  type: "element",
  tagName: "tr",
  properties: {},
  children: cells.map((c) => cell(tag, c)),
});
const table = (head, rows) => ({
  type: "element",
  tagName: "table",
  properties: {},
  children: [
    { type: "element", tagName: "thead", properties: {}, children: [tr("th", head)] },
    { type: "element", tagName: "tbody", properties: {}, children: rows.map((r) => tr("td", r)) },
  ],
});
const run = (node) => {
  const root = { type: "root", children: [node] };
  rehypeTables()(root);
  return root.children[0];
};
const cls = (node) => node.properties.className?.[0];
const sentence = "buys and sells when you type a command";

test("a table with sentences becomes a numbered list: name, text, then labelled extras", () => {
  const out = run(
    table(["Agent", "What it does", "Class"], [["A trading bot", sentence, "A1, token info"]]),
  );
  assert.equal(out.tagName, "ol");
  const li = out.children[0];
  assert.equal(textOf(li), `A trading bot: ${sentence}. Class: A1, token info`);
  assert.equal(li.children[0].tagName, "strong");
});

test("with two columns it is just the name and its text", () => {
  const out = run(table(["Name", "What it means"], [["Runner", sentence]]));
  assert.equal(textOf(out.children[0]), `Runner: ${sentence}`);
});

test("a bare number as a name gets its column's name", () => {
  const out = run(table(["Agent", "What it shows"], [["1", sentence]]));
  assert.equal(out.children[0].children[0].children[0].value, "Agent 1"); // inside the <strong>
});

test("a table of short values stays a table", () => {
  const node = table(
    ["Contract", "Address"],
    [["CoverPool", "0xba8f66D2BBb87B66f42faE0F83Be14A180BF21F9"]],
  );
  assert.equal(layoutOf(node), "table");
  assert.equal(cls(run(node)), "table-wrap");
});

test("a short value in the second column keeps its column's name", () => {
  const out = run(
    table(["Model", "Security score", "Weakest row"], [["DeepSeek", "33", sentence]]),
  );
  assert.equal(textOf(out.children[0]), `DeepSeek: Security score: 33. Weakest row: ${sentence}`);
});
