import { screen } from "@testing-library/react";

/**
 * Code blocks are highlighted, so their text is split across spans and no single element holds a
 * whole command. These find the block (its <pre>) by its full text instead: a string for an exact
 * match, a pattern for a part of it.
 */
const isCode = (text: string | RegExp) => (_own: string, el: Element | null) =>
  el?.tagName === "PRE" &&
  (typeof text === "string" ? el.textContent === text : text.test(el.textContent ?? ""));

export const getCodeBlock = (text: string | RegExp) => screen.getByText(isCode(text));
// A pipeline runs every package's tests at once, so a page can take longer than findBy's default
// second to show a command; a slow machine is not a failure.
export const findCodeBlock = (text: string | RegExp) =>
  screen.findByText(isCode(text), {}, { timeout: 8_000 });
export const queryCodeBlock = (text: string | RegExp) => screen.queryByText(isCode(text));
