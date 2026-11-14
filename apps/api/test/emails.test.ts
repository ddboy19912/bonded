import { describe, expect, it } from "vitest";
import { emailLayout, escapeHtml, signInCodeEmail } from "../src/emails.js";

describe("emails", () => {
  it("puts the sign-in code first in the subject, and in the text and the HTML", () => {
    const m = signInCodeEmail("490217");
    expect(m.subject).toBe("490217 is your Bonded sign-in code");
    expect(m.text).toContain("Your Bonded sign-in code is 490217.");
    expect(m.text).toContain("It works once, for 10 minutes.");
    expect(m.html).toContain(">490217</div>");
    // The inbox preview line, hidden in the body.
    expect(m.html).toContain("490217. It works once, for 10 minutes.");
    expect(m.html.startsWith("<!doctype html>")).toBe(true);
  });

  it("only takes a 6-digit code", () => {
    expect(() => signInCodeEmail("12345")).toThrow("6 digits");
    expect(() => signInCodeEmail("<b>12</b>")).toThrow("6 digits");
  });

  it("escapes the plain-text parts of the frame", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
    const html = emailLayout({
      title: "<t>",
      preheader: "<p>",
      body: "<b>kept</b>",
      footnote: "<f>",
    });
    expect(html).toContain("<title>&lt;t&gt;</title>");
    expect(html).toContain("&lt;p&gt;");
    expect(html).toContain("&lt;f&gt;");
    expect(html).toContain("<b>kept</b>");
  });
});
