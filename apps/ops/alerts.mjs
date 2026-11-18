// Telegram alerts for the ops dashboard: a message when a check goes low or down, another when it
// recovers, and a reminder once a day while it stays bad. Messages carry check names and their
// values (a balance, "Up", a queue count), never keys or error text.

const DAY_MS = 24 * 60 * 60 * 1000;
const BAD = new Set(["low", "down"]);
const LABEL = { low: "Low", down: "Down" };

const keyOf = (r) => `${r.group}::${r.name}`;

/**
 * What to say after a round of checks. `state` maps each check to its last status and when it was
 * last reported; it is updated in place. Checks marked "manual" are reminders, never alerts.
 */
export function alertsFor(results, state, now = Date.now()) {
  const messages = [];
  for (const r of results) {
    if (r.status === "manual") continue;
    const key = keyOf(r);
    const prev = state.get(key);
    const bad = BAD.has(r.status);
    if (!prev) {
      // The first round only reports what's already wrong, so a restart doesn't spam "OK".
      state.set(key, { status: r.status, at: now });
      if (bad) messages.push(`⚠️ ${r.name}: ${LABEL[r.status]} (${r.value})`);
      continue;
    }
    if (bad && (prev.status !== r.status || now - prev.at >= DAY_MS)) {
      messages.push(
        `⚠️ ${r.name}: ${LABEL[r.status]} (${r.value})${prev.status === r.status ? ", still" : ""}`,
      );
      state.set(key, { status: r.status, at: now });
    } else if (!bad && BAD.has(prev.status)) {
      messages.push(`✅ ${r.name}: OK again (${r.value})`);
      state.set(key, { status: r.status, at: now });
    } else if (prev.status !== r.status) {
      state.set(key, { status: r.status, at: now });
    }
  }
  return messages;
}

/** Sends one Telegram message; failures are logged without the token. */
export async function sendTelegram(text, env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    if (!res.ok) console.warn(`ops: Telegram answered ${res.status}`);
    return res.ok;
  } catch {
    console.warn("ops: Telegram unreachable");
    return false;
  }
}
