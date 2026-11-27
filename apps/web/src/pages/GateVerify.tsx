import { useState } from "react";
import { GATE_RULE_WORDS, type GateRule } from "@bondedhq/shared";
import {
  decisionTitle,
  decisionFromReceipt,
  gateApi,
  parseSharedReceipt,
  verifyDecision,
  type SharedReceipt,
  type Verification,
} from "../lib/gate";
import { Button, Page, Section } from "../components/ui";
import { RESULT } from "../components/gate/activity";
import { VerificationList, useChainRoot } from "../components/gate/verification";

const AREA =
  "min-h-48 w-full rounded-xl border border-line-strong bg-transparent px-4 py-3.5 font-mono text-[13px] leading-relaxed text-ink outline-none transition placeholder:text-dim hover:border-white/30 focus:border-brand-bright";

/** The colour of a result's word, set large as the verdict. */
const VERDICT = { safe: "text-safe", breach: "text-breach", warn: "text-warn" } as const;

/**
 * Check a payment gate receipt without signing in (/gate/verify): paste an agent's check answer or
 * a receipt the owner copied, and the browser checks Bonded's signature, the input hash, the rules
 * run again, and the receipt's place in its day's log, read from GateAnchor on chain.
 */
export function GateVerify() {
  const chainRoot = useChainRoot();
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<{ shared: SharedReceipt; result: Verification }>();
  const [invalid, setInvalid] = useState(false);
  const [running, setRunning] = useState(false);
  const run = async () => {
    const shared = parseSharedReceipt(text.trim());
    setInvalid(!shared);
    setChecked(undefined);
    if (!shared) return;
    setRunning(true);
    try {
      const { proof } = shared;
      const result = await verifyDecision(decisionFromReceipt(shared), {
        receiptKey: gateApi.receiptKey,
        proof: () => (proof ? Promise.resolve(proof) : Promise.reject(new Error("no proof"))),
        ...(chainRoot ? { chainRoot } : {}),
      });
      if (!proof)
        result.log = {
          ok: null,
          detail:
            "No log proof pasted. The account's owner can copy the receipt with its proof once the day has ended (UTC).",
        };
      setChecked({ shared, result });
    } finally {
      setRunning(false);
    }
  };
  return (
    <Page
      title="Check a receipt"
      eyebrow="Payment gate"
      back={{ to: "/gate", label: "Payment gate" }}
      intro="Every payment gate decision comes with a signed receipt. Paste one to check it here, in your browser. No sign-in."
    >
      <Section label="No sign-in" title="Paste a receipt">
        <form
          className="flex max-w-3xl flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div className="flex flex-col gap-2 text-sm">
            <label htmlFor="gate-receipt" className="eyebrow">
              Receipt
            </label>
            <textarea
              id="gate-receipt"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='{"receipt": {...}, "input": {...}}'
              spellCheck={false}
              aria-invalid={invalid}
              aria-describedby="gate-receipt-hint"
              className={AREA}
            />
            <span
              id="gate-receipt-hint"
              className={`text-xs ${invalid ? "text-breach" : "text-muted"}`}
            >
              {invalid
                ? "That isn't a gate receipt. Paste the whole answer from a check, or a copied receipt."
                : "An agent's check answer, or a receipt copied from the gate page."}
            </span>
          </div>
          <div>
            <Button type="submit" size="lg" loading={running} disabled={!text.trim()}>
              Check
            </Button>
          </div>
        </form>
      </Section>
      {checked && <Checked shared={checked.shared} result={checked.result} />}
    </Page>
  );
}

/** What the receipt says, then which checks passed. */
function Checked({ shared, result }: { shared: SharedReceipt; result: Verification }) {
  const r = shared.receipt.receipt;
  const tone = RESULT[r.result];
  return (
    <Section label="Result">
      <div className="grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <p className={`num-giant ${VERDICT[tone.tone]}`}>{tone.label}</p>
          <p className="h-section">
            {r.kind === "bank_change"
              ? "Bank change"
              : decisionTitle({ kind: r.kind, amountUsd: r.amountCents / 100, vendorId: null })}
          </p>
          <dl className="flex flex-col divide-y divide-line border-y border-line text-sm">
            <div className="flex items-baseline justify-between gap-6 py-3">
              <dt className="eyebrow shrink-0">Payee</dt>
              <dd className="min-w-0 text-right font-mono text-[0.92em] break-all">{r.payee}</dd>
            </div>
            {r.reference && (
              <div className="flex items-baseline justify-between gap-6 py-3">
                <dt className="eyebrow shrink-0">Reference</dt>
                <dd className="min-w-0 text-right break-words">{r.reference}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-6 py-3">
              <dt className="eyebrow shrink-0">Checked</dt>
              <dd className="min-w-0 text-right">
                <time dateTime={new Date(r.checkedAt * 1000).toISOString()}>
                  {new Date(r.checkedAt * 1000).toUTCString()}
                </time>
              </dd>
            </div>
          </dl>
          {r.rules.length > 0 && (
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[15px] text-soft">
              {r.rules.map((rule) => (
                <li key={rule}>{GATE_RULE_WORDS[rule as GateRule] ?? rule}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0">
          <VerificationList result={result} />
        </div>
      </div>
    </Section>
  );
}
