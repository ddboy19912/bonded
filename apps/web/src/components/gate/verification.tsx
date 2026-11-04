import { useState } from "react";
import { Link } from "react-router";
import { usePublicClient } from "wagmi";
import { gateAnchorAbi } from "@bondedhq/shared";
import type { Hex } from "viem";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";
import { deployment } from "../../config";
import {
  gateApi,
  verifyDecision,
  type ChainRootQuery,
  type GateDecision,
  type GateProof,
  type Verification,
  type VerifyStep,
} from "../../lib/gate";
import { CopyButton } from "../copy";
import { linkClass } from "../ui";

/**
 * Reads a day's root from the app's own GateAnchor (`gateAnchor` in the deployment file): the
 * zero hash when none is posted, null when it can't be read here.
 */
export type ChainRoot = (at: ChainRootQuery) => Promise<Hex | null>;

const STEPS: { key: keyof Verification; label: string }[] = [
  { key: "signature", label: "Bonded's signature" },
  { key: "input", label: "Input hash" },
  { key: "rules", label: "Rules, run again" },
  { key: "log", label: "Daily log root" },
];

function StepBadge({ step }: { step: VerifyStep }) {
  if (step.ok === true) return <Badge variant="safe">Passed</Badge>;
  if (step.ok === false) return <Badge variant="breach">Failed</Badge>;
  return <Badge variant="secondary">Not checked</Badge>;
}

/** Check one decision in the browser, and show which checks passed. */
export function VerifyPanel({
  decision,
  session,
  accountId,
  chainRoot,
}: {
  decision: GateDecision;
  session: string;
  accountId: string;
  chainRoot?: ChainRoot | undefined;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Verification>();
  // The log proof Verify loaded, so the copied receipt carries it.
  const [proof, setProof] = useState<GateProof>();
  const run = async () => {
    setRunning(true);
    try {
      setResult(
        await verifyDecision(decision, {
          receiptKey: gateApi.receiptKey,
          proof: async () => {
            const p = await gateApi.proof(session, accountId, decision.id);
            setProof(p);
            return p;
          },
          ...(chainRoot ? { chainRoot } : {}),
        }),
      );
    } finally {
      setRunning(false);
    }
  };
  const shared = JSON.stringify({
    receipt: decision.receipt,
    input: decision.input,
    ...(proof ? { proof } : {}),
  });
  return (
    <div className="flex flex-col gap-4">
      {result && <VerificationList result={result} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={running} onClick={() => void run()}>
          {running && <Spinner aria-hidden />}
          {result ? "Verify again" : "Verify"}
        </Button>
        <CopyButton text={shared} label={proof ? "Copy receipt and proof" : "Copy receipt"} />
        <Link to="/gate/verify" className={`${linkClass} ml-auto text-xs`}>
          Anyone can check it
        </Link>
      </div>
    </div>
  );
}

/** Which checks of a decision passed, failed or couldn't run, each with why. */
export function VerificationList({ result }: { result: Verification }) {
  const failed = STEPS.filter((s) => result[s.key].ok === false).length;
  return (
    <div aria-label="Verification" className="flex flex-col gap-1">
      <p className="text-sm font-semibold" role="status">
        {failed === 0
          ? "No check failed."
          : `${failed} ${failed === 1 ? "check" : "checks"} failed.`}
      </p>
      <ul className="flex flex-col divide-y divide-line">
        {STEPS.map((s) => (
          <li key={s.key} className="flex flex-col gap-1 py-2.5 text-sm">
            <span className="flex items-center justify-between gap-3">
              <span>{s.label}</span>
              <StepBadge step={result[s.key]} />
            </span>
            <span className="text-xs text-muted">{result[s.key].detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The root posted on chain, read straight from the app's own GateAnchor: never from an address
 * the API or a pasted receipt names. Not read when the API says it was posted somewhere else.
 */
export function useChainRoot(): ChainRoot | undefined {
  const client = usePublicClient();
  const anchor = deployment.gateAnchor;
  return client && anchor
    ? async ({ accountKey, dayNumber, posted }) =>
        posted &&
        (posted.chainId !== deployment.chainId ||
          posted.contract.toLowerCase() !== anchor.toLowerCase())
          ? null
          : (
              await client.readContract({
                address: anchor,
                abi: gateAnchorAbi,
                functionName: "logRootOf",
                args: [accountKey, dayNumber],
              })
            ).hash
    : undefined;
}
