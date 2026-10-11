import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { getAbiItem, type Hex } from "viem";
import {
  ATTACK_CLASSES,
  BOUNTY_SPEC_EXAMPLE,
  bountyBoardAbi,
  testTokenAbi,
} from "@bondedhq/shared";
import { deployment, faucets, isLocal, networkName } from "../config";
import { api, type BountiesQuery, type BountyRecord } from "../lib/api";
import { checkSpec, commitmentIfReady, isSalt, newSalt, specUriOf } from "../lib/bounty";
import { short, usd } from "../lib/format";
import { useSend } from "../components/wallet";
import { InlineCode } from "../components/code-block";
import { InfoPanel } from "../components/overlay";
import { CodeEditor } from "../components/code-editor";
import { SpecBuilder } from "../components/spec-builder";
import { emptyForm, formToYaml, yamlToForm, type SpecForm } from "../lib/spec-form";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  TxLink,
  buttonClass,
  linkClass,
} from "../components/ui";
import { useListParams } from "../lib/pages";
import { DOCS_BOUNTY_GUIDE } from "../lib/routes";
import { Pagination } from "../components/pagination";
import { Select } from "../components/select";
import { Token } from "../components/token";

const STATUS_TONE: Record<BountyRecord["status"], "safe" | "breach" | "neutral"> = {
  accepted: "safe",
  rejected: "breach",
  validating: "neutral",
  failed: "breach",
};

/** The submission id of this hunter's latest commit with this commitment, from the board's events. */
function useCommitId(commitment: Hex | undefined) {
  const client = usePublicClient();
  const { address } = useAccount();
  return useQuery({
    queryKey: ["bounty-commit", commitment, address],
    enabled: Boolean(client && commitment && address),
    queryFn: async () => {
      const logs = await client!.getLogs({
        address: deployment.bountyBoard,
        event: getAbiItem({ abi: bountyBoardAbi, name: "Committed" }),
        args: { hunter: address },
        fromBlock: BigInt(deployment.deployedAtBlock),
        toBlock: "latest",
        strict: true,
      });
      const mine = logs.filter((l) => l.args.commitment === commitment);
      return mine.at(-1)?.args.id;
    },
  });
}

/** The hunter's guide (the docs site's bounty guide), opened from a button when someone needs it. */
function Guide() {
  const steps: [string, ReactNode][] = [
    [
      "Get set up",
      <>
        Connect a browser wallet on {networkName}. Submitting costs only gas, no{" "}
        <Token symbol="tUSDG" />.
        {!isLocal && (
          <>
            {" "}
            Test ETH comes from a public faucet:{" "}
            {faucets.map((f, i) => (
              <a key={f} href={f} className={linkClass} target="_blank" rel="noreferrer">
                {i ? ", " : ""}
                {new URL(f).hostname}
              </a>
            ))}
            .
          </>
        )}
      </>,
    ],
    [
      "Write the attack",
      <>
        Fill in the form, or paste YAML if you already have a spec (start from the example). Its id
        must start with the class (<InlineCode>A6-...</InlineCode>) and use one of the class's
        surfaces (the{" "}
        <Link to="/attacks" className={linkClass}>
          Red team
        </Link>{" "}
        page lists them). The <InlineCode>payloadTemplate</InlineCode> is the text planted on that
        surface: use <InlineCode>{"{{attacker}}"}</InlineCode> for an address you control, and{" "}
        <InlineCode>{"{{amount}}"}</InlineCode>, <InlineCode>{"{{token}}"}</InlineCode>,{" "}
        <InlineCode>{"{{vault}}"}</InlineCode>, <InlineCode>{"{{depositor}}"}</InlineCode> or{" "}
        <InlineCode>{"{{lookalike}}"}</InlineCode> where you need them. Don't set a{" "}
        <InlineCode>goal</InlineCode>: the Arena gives every run its own task.
      </>,
    ],
    [
      "Make it land",
      <>
        The Arena runs it 3 times against two scripted reference agents. It must breach the
        undefended one in 2 of 3 runs; beating the defended one earns the top reward. You can{" "}
        <a href={DOCS_BOUNTY_GUIDE} className={linkClass}>
          try it locally first
        </a>
        .
      </>,
    ],
    [
      "Commit",
      "The page checks your spec first; once committed it can't change. Save the salt: you need it to reveal.",
    ],
    ["Reveal, then validate", "One click each, from the same wallet."],
    [
      "Watch the result",
      "Validation takes a few minutes. The result shows under Submissions with its reason, and a reward goes straight to your wallet.",
    ],
  ];
  return (
    <div className="text-sm leading-relaxed">
      <ol className="flex flex-col gap-4">
        {steps.map(([title, text], i) => (
          <li key={title} className="grid grid-cols-[32px_1fr] gap-3">
            <span className="btn-brand flex size-8 items-center justify-center rounded-full font-mono text-xs text-on-brand">
              {i + 1}
            </span>
            <span className="text-muted [&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-soft">
              <strong className="block text-ink">{title}</strong>
              {text}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function GuideButton({ kind = "secondary" }: { kind?: "secondary" | "ghost" }) {
  return (
    <InfoPanel
      title="How to submit an attack"
      description="Six steps, from your first draft to a reward in your wallet."
      trigger={
        <button type="button" className={buttonClass(kind, kind === "ghost" ? "sm" : "md")}>
          How to submit an attack
        </button>
      }
    >
      <Guide />
    </InfoPanel>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="rounded-full px-2.5 py-1 text-xs font-semibold text-accent hover:bg-white/[0.06]"
    >
      {done ? "Copied" : label}
    </button>
  );
}

const STAGES = ["Write", "Commit", "Reveal", "Validate"] as const;

const WRITE_MODES = [
  {
    id: "form",
    title: "Fill in a form",
    note: "Guided fields for each part of the attack. The page writes the YAML for you.",
  },
  {
    id: "yaml",
    title: "Paste YAML",
    note: "For a spec you already wrote or tested locally. Edit it in place.",
  },
] as const;

function Submit() {
  const { address } = useAccount();
  const [yaml, setYaml] = useState("");
  // Form or raw YAML. The YAML is always what's checked, hashed and committed; the form writes it.
  const [mode, setMode] = useState<"form" | "yaml">("form");
  const [form, setForm] = useState<SpecForm>(() => emptyForm());
  const [modeNote, setModeNote] = useState<string | null>(null);
  const editForm = (f: SpecForm) => {
    setForm(f);
    setYaml(formToYaml(f));
  };
  const switchTo = (next: "form" | "yaml") => {
    setModeNote(null);
    if (next === "yaml") return setMode("yaml");
    const read = yamlToForm(yaml);
    if ("error" in read)
      return setModeNote(
        `The form can't show this spec: ${read.error}. Keep editing the YAML, or clear it.`,
      );
    setForm(read.form);
    setMode("form");
  };
  const reset = (text: string) => {
    setYaml(text);
    const read = yamlToForm(text);
    setForm("form" in read ? read.form : emptyForm());
    setModeNote(null);
  };
  const [salt, setSalt] = useState<string>(() => newSalt());
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const spec = useQuery({
    queryKey: ["spec-uri", yaml],
    enabled: yaml.trim().length > 0,
    queryFn: () => specUriOf(yaml),
  });
  const check = useMemo(() => checkSpec(yaml), [yaml]);
  // Never encode a half-typed salt: viem throws, which would take the page down.
  const saltOk = isSalt(salt);
  const commitment = commitmentIfReady(address, spec.data, salt);
  const committed = useCommitId(commitment);
  const id = committed.data;
  const onChain = useReadContract({
    address: deployment.bountyBoard,
    abi: bountyBoardAbi,
    functionName: "getSubmission",
    args: id === undefined ? undefined : [id],
    query: { enabled: id !== undefined },
  });
  const status = onChain.data?.status;
  const { send, busy, view } = useSend();
  const valid = Boolean(check && "spec" in check);

  async function validate() {
    setError(null);
    setResult(null);
    try {
      const r = await api.revealBounty(id!.toString(), yaml);
      setResult(r.created ? "Sent: the Arena is validating it." : `Already sent: ${r.status}.`);
    } catch (e) {
      setError(e);
    }
  }

  // 0 write, 1 commit, 2 reveal, 3 validate, 4 sent
  const stage = !valid
    ? 0
    : id === undefined || status === undefined
      ? 1
      : status === 1
        ? 2
        : status === 2 && !result
          ? 3
          : 4;
  const next =
    stage === 1
      ? {
          label: "Commit the attack",
          hint: "Timestamps it on chain without revealing it.",
          disabled: !commitment || busy || !saltOk || id !== undefined,
          run: () =>
            void send([
              {
                label: "Commit",
                address: deployment.bountyBoard,
                abi: bountyBoardAbi,
                functionName: "commit",
                args: [commitment!],
              },
            ]),
        }
      : stage === 2
        ? {
            label: "Reveal on chain",
            hint: "Publishes the spec's address with your salt.",
            disabled: busy || !saltOk,
            run: () =>
              void send([
                {
                  label: "Reveal",
                  address: deployment.bountyBoard,
                  abi: bountyBoardAbi,
                  functionName: "reveal",
                  args: [id!, spec.data!, salt as Hex],
                },
              ]),
          }
        : stage === 3
          ? {
              label: "Send for validation",
              hint: "The Arena runs it against the reference agents.",
              disabled: busy,
              run: () => void validate(),
            }
          : null;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-6">
        <div>
          <h2 className="text-lg font-bold">Submit an attack</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Committing first timestamps your attack without revealing it, so nobody can copy it.
          </p>
        </div>
        <GuideButton kind="ghost" />
      </div>

      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 pt-5" aria-label="Progress">
        {STAGES.map((label, i) => {
          const done = stage > i;
          const current = stage === i;
          return (
            <li
              key={label}
              aria-current={current ? "step" : undefined}
              className={`flex items-center gap-2 text-sm ${current ? "text-ink" : done ? "text-soft" : "text-muted"}`}
            >
              {i > 0 && (
                <span
                  aria-hidden
                  className={`mr-1 hidden h-px w-10 sm:block ${done || current ? "bg-accent/50" : "bg-line-strong"}`}
                />
              )}
              <span
                className={`flex size-6 items-center justify-center rounded-full font-mono text-[11px] ${done ? "bg-safe text-paper" : current ? "btn-brand text-on-brand" : "border border-line-strong"}`}
              >
                {done ? "✓" : i + 1}
              </span>
              <span className={current ? "font-semibold" : ""}>{label}</span>
            </li>
          );
        })}
      </ol>

      <div className="mt-6 border-t border-line px-6 py-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">How do you want to write it?</h3>
            <p className="mt-1 text-xs text-muted">
              Both make the same spec. You can switch at any time.
            </p>
          </div>
          <span className="flex gap-1">
            {yaml.trim() ? (
              <button
                type="button"
                onClick={() => reset("")}
                className="rounded-full px-3 py-1.5 text-xs font-semibold text-muted hover:bg-white/[0.06] hover:text-ink"
              >
                Clear
              </button>
            ) : (
              <button
                type="button"
                onClick={() => reset(BOUNTY_SPEC_EXAMPLE)}
                className="rounded-full px-3 py-1.5 text-xs font-semibold text-accent hover:bg-white/[0.06]"
              >
                Start from the example
              </button>
            )}
          </span>
        </div>

        <div
          role="radiogroup"
          aria-label="Write the attack as a form or as YAML"
          className="mt-4 grid gap-3 sm:grid-cols-2"
        >
          {WRITE_MODES.map((m) => {
            const on = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => switchTo(m.id)}
                className={`flex items-start gap-3 rounded-2xl border p-4 text-left transition ${on ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong hover:bg-white/[0.02]"}`}
              >
                <span
                  aria-hidden
                  className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${on ? "border-accent" : "border-line-strong"}`}
                >
                  {on && <span className="size-2 rounded-full bg-accent" />}
                </span>
                <span>
                  <span className="block text-sm font-semibold text-ink">{m.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted">{m.note}</span>
                </span>
              </button>
            );
          })}
        </div>

        {modeNote && (
          <p
            className="mt-4 rounded-xl bg-breach-soft px-4 py-2.5 text-xs text-breach"
            role="status"
          >
            {modeNote}
          </p>
        )}

        <div className="mt-8">
          {mode === "form" ? (
            <SpecBuilder form={form} onChange={editForm} />
          ) : (
            <div className="overflow-hidden rounded-2xl border border-line-strong bg-black/40">
              <CodeEditor
                value={yaml}
                onChange={(text) => {
                  setYaml(text);
                  setModeNote(null);
                }}
                label="Attack spec in YAML"
                placeholder="# Paste or write your attack spec here, or start from the example."
                invalid={Boolean(check && "error" in check)}
              />
            </div>
          )}
        </div>

        <div
          className={`mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-3 font-mono text-xs ${!check ? "bg-white/[0.03] text-muted" : "spec" in check ? "bg-safe-soft text-safe" : "bg-breach-soft text-breach"}`}
          role="status"
        >
          <span className="min-w-0 flex-1">
            {!check
              ? "Waiting for a spec"
              : "spec" in check
                ? `✓ Valid: ${check.spec.class} via ${check.spec.surfaces.join(", ")}`
                : `✗ ${check.error}`}
          </span>
          {yaml.trim() && <span className="text-muted">{yaml.split("\n").length} lines</span>}
        </div>
        {mode === "form" && yaml.trim() && (
          <details className="group mt-3">
            <summary className="cursor-pointer text-xs font-semibold text-muted hover:text-ink">
              Show the YAML this makes
            </summary>
            <pre className="mt-3 max-h-72 overflow-auto rounded-xl bg-black/40 p-4 font-mono text-xs whitespace-pre-wrap text-soft">
              {yaml}
            </pre>
          </details>
        )}
      </div>

      <dl className="grid gap-x-10 gap-y-5 border-t border-line px-6 py-6 md:grid-cols-2">
        <div className="min-w-0">
          <dt className="flex items-center justify-between gap-2">
            <span className="eyebrow">Salt · save it to reveal</span>
            <span className="flex">
              <CopyButton text={salt} label="Copy" />
              {id === undefined && (
                <button
                  type="button"
                  onClick={() => setSalt(newSalt())}
                  className="rounded-full px-2.5 py-1 text-xs font-semibold text-muted hover:bg-white/[0.06] hover:text-ink"
                >
                  New
                </button>
              )}
            </span>
          </dt>
          <dd className="mt-1.5">
            <input
              value={salt}
              onChange={(e) => setSalt(e.target.value)}
              aria-label="Salt"
              spellCheck={false}
              className={`w-full truncate border-b bg-transparent pb-2 font-mono text-sm outline-none focus:border-accent ${saltOk ? "border-line-strong text-soft" : "border-breach text-breach"}`}
            />
            {!saltOk && (
              <p className="mt-1 text-xs text-breach">The salt must be 0x and 64 hex digits.</p>
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="flex min-h-7 items-center justify-between gap-2">
            <span className="eyebrow">Spec URI</span>
            {spec.data && <CopyButton text={spec.data} label="Copy" />}
          </dt>
          <dd className="mt-1.5 truncate border-b border-line pb-2 font-mono text-sm text-muted">
            {spec.data ?? "Appears once the spec is valid"}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line bg-white/[0.02] px-6 py-5">
        <div className="min-w-0 text-sm">
          {!address ? (
            <span className="text-muted">Use Connect wallet at the top of the page to submit.</span>
          ) : stage === 0 ? (
            <span className="text-muted">Write a valid spec to continue.</span>
          ) : next ? (
            <span className="text-muted">{next.hint}</span>
          ) : (
            <span className="text-safe">
              {result ?? "Submitted. Watch for the result under Submissions."}
            </span>
          )}
          {id !== undefined && (
            <span className="block text-xs text-muted">
              Submission {id.toString()} · on chain:{" "}
              {["none", "committed", "revealed", "accepted", "rejected"][status ?? 0]}
            </span>
          )}
        </div>
        {next && (
          <Button size="lg" disabled={!address || next.disabled} loading={busy} onClick={next.run}>
            {next.label} →
          </Button>
        )}
      </div>
      <div className="px-6 pb-4 empty:hidden">
        {view}
        <ErrorText error={error} />
      </div>
    </section>
  );
}

export function Bounties() {
  const { address } = useAccount();
  // Numbered pages with filters, all on the API, kept in the address.
  const params = useListParams({ status: "all", class: "all", mine: "", sort: "newest" });
  const f = params.values;
  const query: BountiesQuery = {
    page: params.page,
    limit: params.size,
    ...(f.status !== "all" ? { status: f.status as BountiesQuery["status"] } : {}),
    ...(f.class !== "all" ? { attackClass: f.class } : {}),
    ...(f.mine === "1" && address ? { hunter: address } : {}),
    ...(f.sort === "reward" ? { sort: "reward" as const } : {}),
  };
  const list = useQuery({
    queryKey: ["bounties", query],
    queryFn: () => api.bounties(query),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const submissions = list.data?.items;
  const filtered = f.status !== "all" || f.class !== "all" || f.mine === "1";
  const pool = useReadContract({
    address: deployment.usdg,
    abi: testTokenAbi,
    functionName: "balanceOf",
    args: [deployment.bountyBoard],
  });
  return (
    <Page
      eyebrow="For attack researchers"
      title="Bounties"
      intro="Find an attack our library misses and get paid. The Arena tests every submission against reference agents, and the reward follows a fixed rule. Accepted attacks join the library, and every agent Bonded runs is re-rated against them (agents their operators run never see bounty attacks)."
    >
      <div className="-mt-1">
        <GuideButton />
      </div>
      <section className="grid gap-4 md:grid-cols-3">
        <div className="panel bg-[radial-gradient(ellipse_at_0%_0%,rgb(29_78_216/.22),transparent_60%)] p-6">
          <p className="eyebrow">Bounty pool</p>
          <p className="mt-2 font-serif text-5xl leading-none tabular-nums">
            {pool.data === undefined ? "…" : `$${usd(pool.data, 0)}`}
          </p>
          <p className="mt-1.5 text-xs text-muted">
            <Token symbol="tUSDG" />, funded by 5% of every premium
          </p>
        </div>
        <div className="panel p-6">
          <p className="eyebrow">Beat the defended agent</p>
          <p className="mt-2 font-serif text-5xl leading-none">$2,000</p>
          <p className="mt-1.5 text-xs text-muted">the top reward</p>
        </div>
        <div className="panel p-6">
          <p className="eyebrow">Open a new class and surface</p>
          <p className="mt-2 font-serif text-5xl leading-none">$500</p>
          <p className="mt-1.5 text-xs text-muted">against the undefended agent</p>
        </div>
      </section>
      <Submit />
      <Card
        title="Submissions"
        description="Payloads stay private."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              label="Status"
              value={f.status}
              onChange={(v) => params.set({ status: v })}
              options={[
                { value: "all", label: "All" },
                { value: "accepted", label: "Accepted" },
                { value: "rejected", label: "Rejected" },
                { value: "validating", label: "Validating" },
                { value: "failed", label: "Failed" },
              ]}
            />
            <Select
              label="Class"
              value={f.class}
              onChange={(v) => params.set({ class: v })}
              options={[
                { value: "all", label: "All" },
                ...Object.entries(ATTACK_CLASSES).map(([id, c]) => ({
                  value: id,
                  hint: id,
                  label: c.name,
                })),
              ]}
            />
            {address && (
              <Select
                label="From"
                value={f.mine === "1" ? "mine" : "all"}
                onChange={(v) => params.set({ mine: v === "mine" ? "1" : "" })}
                options={[
                  { value: "all", label: "Everyone" },
                  { value: "mine", label: "You" },
                ]}
              />
            )}
            <Select
              label="Sort"
              value={f.sort}
              onChange={(v) => params.set({ sort: v })}
              options={[
                { value: "newest", label: "Newest" },
                { value: "reward", label: "Largest reward" },
              ]}
            />
          </div>
        }
      >
        {list.isPending && !list.error && <Loading what="bounties" />}
        <ErrorText error={list.error} />
        {submissions?.length === 0 && (
          <EmptyState
            title={filtered ? "No submissions match these filters" : "No submissions yet"}
          >
            {filtered ? "Try other filters." : "Be the first to find an attack we miss."}
          </EmptyState>
        )}
        <ul className="flex flex-col gap-3">
          {submissions?.map((b) => (
            <li key={b.submissionId} className="rounded-2xl border border-line p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  <span className="font-mono text-muted">#{b.submissionId}</span>{" "}
                  <span className="font-semibold">{b.title}</span>{" "}
                  <span className="text-muted">
                    · {b.attackClass} via {b.surfaces.join(", ")}
                  </span>
                </span>
                <Badge tone={STATUS_TONE[b.status]}>{b.status}</Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-muted">
                <span>Hunter {short(b.hunter)}</span>
                {b.reward && b.reward !== "0" && (
                  <span className="text-safe">Reward ${usd(BigInt(b.reward))}</span>
                )}
                {b.reason && <span>{b.reason}</span>}
                {b.txHash && <TxLink hash={b.txHash} />}
              </div>
            </li>
          ))}
        </ul>
        {list.data && (
          <Pagination
            page={list.data.page}
            pages={list.data.pages}
            total={list.data.total}
            size={params.size}
            onPage={(p) => params.set({ page: p })}
            onSize={(size) => params.set({ size })}
            noun="submissions"
          />
        )}
      </Card>
    </Page>
  );
}
