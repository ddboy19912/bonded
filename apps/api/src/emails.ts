/**
 * Bonded's emails as plain text and as HTML. The HTML is built for email clients: tables, inline
 * styles, no web fonts and no CSS they would strip. It is always light (email clients that switch
 * to dark recolour it on their own) and reads fine with images blocked.
 */

const SITE = "https://www.bondedhq.xyz";
const ICON = `${SITE}/brand/icon-192.png`;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";
const INK = "#0b1020";
const BODY = "#3d4556";
const MUTED = "#6b7385";
const BRAND = "#1d4ed8";

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

/** Text for HTML: an email address or anything else a person typed can't become markup. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The frame every email shares: the logo, a white card with the message, and a footnote. The
 * preheader is the line inboxes show next to the subject. Every argument but `body` is plain text;
 * `body` is HTML the caller has escaped.
 */
export function emailLayout({
  title,
  preheader,
  body,
  footnote,
}: {
  title: string;
  preheader: string;
  body: string;
  footnote: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f5f9;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}${"&#8203;&nbsp;".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f5f9;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
<tr><td style="padding:0 4px 20px;">
<a href="${SITE}" style="text-decoration:none;"><img src="${ICON}" width="32" height="32" alt="" style="display:inline-block;width:32px;height:32px;border:0;border-radius:8px;vertical-align:middle;"><span style="display:inline-block;padding-left:10px;font:600 18px/32px ${FONT};color:${INK};vertical-align:middle;">Bonded</span></a>
</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e3e7ef;border-radius:16px;padding:36px 32px;">
${body}
</td></tr>
<tr><td style="padding:20px 4px 0;font:13px/20px ${FONT};color:${MUTED};">
${escapeHtml(footnote)}<br><br>Bonded &middot; <a href="${SITE}" style="color:${MUTED};">bondedhq.xyz</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The email-sign-in code (docs/ACCOUNTS.md). The code leads the subject, so it shows in a notification. */
export function signInCodeEmail(code: string, minutes = 10): EmailMessage {
  if (!/^\d{6}$/.test(code)) throw new Error("a sign-in code is 6 digits");
  const subject = `${code} is your Bonded sign-in code`;
  const lasts = `It works once, for ${minutes} minutes.`;
  const footnote =
    "You got this because someone asked to sign in to Bonded with this address. If it wasn't you, ignore it: nobody can sign in without the code.";
  const body = `<h1 style="margin:0 0 8px;font:600 22px/30px ${FONT};color:${INK};">Your sign-in code</h1>
<p style="margin:0 0 24px;font:15px/24px ${FONT};color:${BODY};">Enter this code on Bonded to sign in.</p>
<div style="background:#f0f4ff;border:1px solid #d6e0ff;border-radius:12px;padding:20px 0 20px 10px;text-align:center;font:600 34px/40px ${MONO};letter-spacing:10px;color:${BRAND};">${code}</div>
<p style="margin:24px 0 0;font:14px/22px ${FONT};color:${BODY};">${lasts}</p>`;
  return {
    subject,
    text: [
      `Your Bonded sign-in code is ${code}.`,
      "",
      `Enter it on Bonded to sign in. ${lasts}`,
      "",
      footnote,
    ].join("\n"),
    html: emailLayout({ title: subject, preheader: `${code}. ${lasts}`, body, footnote }),
  };
}
