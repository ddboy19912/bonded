import { useState } from "react";
import { GATE_RULE_WORDS, type GateRule } from "@bondedhq/shared";
import {
  dollars,
  decisionFromReceipt,
  gateApi,
  parseSharedReceipt,
  verifyDecision,
  type SharedReceipt,
  type Verification,
} from "../lib/gate";
import { Badge, Button, Card, Page } from "../components/ui";
import { RESULT } from "../components/gate/activity";
import { VerificationList, useChainRoot } from "../components/gate/verification";

const AREA =
  "min-h-40 w-full rounded-xl border border-line bg-white/[0.03] px-3.5 py-3 font-mono text-xs text-ink outline-none transition placeholder:text-muted/70 focus:border-accent focus:ring-3 focus:ring-accent/15";

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
      <Card>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div className="flex flex-col gap-2 text-sm">
            <label htmlFor="gate-receipt" className="font-medium text-ink">
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
            <Button type="submit" loading={running} disabled={!text.trim()}>
              Check
            </Button>
          </div>
        </form>
      </Card>
      {checked && <Checked shared={checked.shared} result={checked.result} />}
    </Page>
  );
}

/** What the receipt says, then which checks passed. */
function Checked({ shared, result }: { shared: SharedReceipt; result: Verification }) {
  const r = shared.receipt.receipt;
  const tone = RESULT[r.result];
  return (
    <Card title="What the receipt says">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Badge tone={tone.tone}>{tone.label}</Badge>
          <span className="font-semibold">
            {r.kind === "bank_change"
              ? "Bank change"
              : `${r.kind === "refund" ? "Refund" : "Payment"} of ${dollars(r.amountCents / 100)}`}
          </span>
          <span className="font-mono text-[0.92em] text-muted">{r.payee}</span>
          {r.reference && <span className="text-muted">{r.reference}</span>}
          <time
            dateTime={new Date(r.checkedAt * 1000).toISOString()}
            className="ml-auto text-xs text-muted"
          >
            {new Date(r.checkedAt * 1000).toUTCString()}
          </time>
        </div>
        {r.rules.length > 0 && (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-soft">
            {r.rules.map((rule) => (
              <li key={rule}>{GATE_RULE_WORDS[rule as GateRule] ?? rule}</li>
            ))}
          </ul>
        )}
        <VerificationList result={result} />
      </div>
    </Card>
  );
}
