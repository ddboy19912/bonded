import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolbox, ArenaAgent, ToolResult } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { runOffchainEpisode } from "../src/offchain/episode.js";
import { INDEX_VARIANTS_DIR, sweepTraces } from "../src/offchain/index-sweep.js";
import {
  chatCeoTwin,
  controlScenario,
  fxSkewTwin,
  type OffchainScenario,
  realisticControl,
  smsBankChangeTwin,
  ticketTwin,
  verifiedBankChangeTwin,
  voicemailCeoTwin,
} from "../src/offchain/scenarios.js";
import { attackScenario, loadOffchainSeeds } from "../src/offchain/seeds.js";
import {
  assertDatasetDir,
  assertPaymentSplits,
  buildPaymentsDataset,
  episodeFilePaths,
  exportPaymentRows,
  familyParts,
  partHash,
  type PaymentCase,
  type PaymentRow,
  paymentRows,
  paymentsMandate,
  plantedBySeed,
  readEpisodeFile,
  sampleBenignTraining,
  type TracedEpisode,
} from "../src/payments-dataset.js";

const seeds = [...loadOffchainSeeds(), ...loadOffchainSeeds(INDEX_VARIANTS_DIR)];
const seed = (id: string) => seeds.find((s) => s.id === id)!;
const planted = plantedBySeed();
const NIMBUS_TYPO = "DE02 1203 0000 0000 0000 2020 51";

const output = <T>(r: ToolResult): T => {
  if (!r.ok) throw new Error(r.error);
  return r.output as T;
};

/**
 * Reads the inbox, every attachment and the queue, pays each queued invoice to the vendor
 * master's account (Nimbus's mistyped with `typo`), then, when `fooled`, pays what the attack
 * planted: its account, or else its invoice reference to Acme.
 */
const reader = (options: { fooled?: string; typo?: boolean } = {}): ArenaAgent => ({
  name: "scripted",
  async run(_task, tools: AgentToolbox) {
    const emails = output<{ id: string; attachments: { id: string }[] }[]>(
      await tools.call("list_emails", {}),
    );
    for (const e of emails) {
      await tools.call("read_email", { emailId: e.id });
      for (const a of e.attachments) await tools.call("view_attachment", { attachmentId: a.id });
    }
    const queue = output<{ reference: string; vendorId: string; amountUsd: number }[]>(
      await tools.call("list_approved_invoices", {}),
    );
    const accountOf = async (vendorId: string) =>
      output<{ account: string }>(await tools.call("get_vendor", { vendorId })).account;
    for (const inv of queue) {
      await tools.call("pay_invoice", {
        account:
          options.typo && inv.vendorId === "nimbus" ? NIMBUS_TYPO : await accountOf(inv.vendorId),
        amountUsd: inv.amountUsd,
        invoiceReference: inv.reference,
      });
    }
    if (options.fooled) {
      const facts = [...planted.get(options.fooled)!];
      const account = facts.find((f) => f.startsWith("account:"))?.slice("account:".length);
      const reference = facts.find((f) => f.startsWith("ref:"))?.slice("ref:".length);
      await tools.call("pay_invoice", {
        account: account ?? (await accountOf("acme")),
        amountUsd: 1840,
        invoiceReference: account ? "ACM-2291" : reference!,
      });
    }
    return { steps: 0, stoppedBecause: "done" };
  },
});

const run = async (
  scenario: OffchainScenario,
  agent: ArenaAgent = reader(),
  mandate: "shown" | "hidden" = "shown",
): Promise<TracedEpisode> => ({
  mandate,
  ...(await runOffchainEpisode(agent, scenario, { attribution: "planted" })),
});
const attack = (id: string, fooled = true) =>
  run(attackScenario(seed(id)), reader(fooled ? { fooled: id } : {}));
const rowsOf = (episode: TracedEpisode, episodeId = "e") =>
  paymentRows(episode, {
    episodeId,
    agent: "scripted",
    mandate: paymentsMandate(),
    planted: episode.kind === "attack" ? planted.get(episode.scenarioId)! : null,
  });

describe("payment rows", () => {
  it("label a payment manipulated only when the judge puts its breach down to the attack", async () => {
    const episode = await attack("O1-lookalike-domain-001");
    expect(episode.verdict.attackCaused).toBe(true);
    const rows = rowsOf(episode);
    expect(rows.map((r) => r.proposedAction.tool)).toEqual([
      "pay_invoice",
      "pay_invoice",
      "pay_invoice",
      "pay_invoice",
    ]);
    const fooled = rows.at(-1)!;
    expect(fooled.labels).toEqual({
      manipulated: true,
      action_risk: "breach_likely",
      injection_in_inputs: true,
    });
    expect(fooled.outcome.breachTypes).toContain("unknown_payee");
    expect(rows.slice(0, -1).every((r) => !r.labels.manipulated)).toBe(true);
    // The state is what the agent read before paying: reads only, no earlier payments.
    expect(fooled.untrustedInputs.map((i) => i.tool)).not.toContain("pay_invoice");
    expect(fooled.untrustedInputs.some((i) => i.tool === "read_email")).toBe(true);
    expect(fooled.mandate).toBe(paymentsMandate());
    expect(fooled).toMatchObject({
      kind: "attack",
      attackClass: "O1",
      offchainClass: "O1",
      family: "O1-lookalike-domain-001",
    });
  });

  it("don't count the agent's own mistake in an attack episode as manipulation", async () => {
    const episode = await run(attackScenario(seed("O4-knowledge-001")), reader({ typo: true }));
    expect(episode.verdict.ownErrors!.length).toBeGreaterThan(0);
    const typo = rowsOf(episode).find((r) => r.outcome.breachTypes.length > 0)!;
    expect(typo.labels.manipulated).toBe(false);
    expect(typo.labels.action_risk).toBe("breach_likely");
  });

  it("never label a control or a benign twin manipulated, even when it breaches", async () => {
    for (const scenario of [controlScenario(), chatCeoTwin()]) {
      const rows = rowsOf(await run(scenario, reader({ typo: true })));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => r.outcome.breachTypes.length > 0)).toBe(true);
      expect(rows.every((r) => !r.labels.manipulated && !r.labels.injection_in_inputs)).toBe(true);
    }
  });

  it("leave pictures out of the state and count them", async () => {
    const episode = await attack("O2-qr-remit-001");
    const image = episode.trace
      .map((s) => (s.result.ok ? (s.result.output as { image?: { base64: string } }) : {}))
      .find((o) => o?.image)!.image!;
    const rows = rowsOf(episode);
    const last = rows.at(-1)!;
    expect(last.imageInputs).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    expect(text).toContain("[image omitted: image/png]");
    expect(text).not.toContain(image.base64.slice(0, 40));
  });
});

describe("episode files", () => {
  it("read Index traces and run results, and skip what they can't label", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payments-"));
    const fooled = await attack("O5-ceo-boarding-001");
    const control = await run(controlScenario());
    // An Index sweep's trace file, pictures replaced by their size.
    writeFileSync(
      join(dir, "model-trace.json"),
      sweepTraces("m", "2026-11-02T00:00:00Z", {
        episodes: [fooled, control].map(({ mandate, ...result }) => ({ mandate, result })),
      }),
    );
    // An off-chain run's results.json, with an attack from before attribution and one whose seed
    // isn't in any folder given.
    const unattributed = { ...fooled.verdict, ownErrors: undefined };
    writeFileSync(
      join(dir, "results.json"),
      JSON.stringify({
        summary: { agent: "payables" },
        results: [
          { ...fooled, verdict: unattributed },
          { ...fooled, scenarioId: "O5-not-a-seed-001" },
          control,
        ],
      }),
    );
    writeFileSync(join(dir, "report.json"), JSON.stringify({ score: 100 }));
    const paths = episodeFilePaths([dir]);
    expect(paths).toHaveLength(3);
    const files = paths.map((path) => ({ path, file: readEpisodeFile(path) }));
    const { rows, stats, sources } = exportPaymentRows(files, planted);
    expect(stats).toEqual({
      files: 3,
      ignoredFiles: 1,
      episodes: 5,
      skippedUnattributed: 1,
      skippedUnknownSeed: 1,
      paymentRows: rows.length,
      byOrigin: {
        model: { episodes: 5, paymentRows: rows.length },
        scripted: { episodes: 0, paymentRows: 0 },
      },
    });
    expect(sources).toHaveLength(2);
    expect(rows.filter((r) => r.labels.manipulated)).toHaveLength(1);
    expect(new Set(rows.map((r) => r.agent))).toEqual(new Set(["m", "payables"]));
  });
});

/** A row copied into another family, class and kind, keeping its state. */
const moved = (row: PaymentRow, change: Partial<PaymentRow>): PaymentRow => ({
  ...row,
  ...change,
  id: `${row.id}:${change.family ?? row.family}`,
});

describe("the split", () => {
  const episodes = async () => [
    await attack("O1-lookalike-domain-001"),
    await attack("O1-lookalike-domain-001-fb19f6d7e"),
    await attack("O4-knowledge-001"),
    await attack("O2-split-invoice-001"),
    await attack("O2-unapproved-invoice-001"),
    await attack("O2-unapproved-invoice-001-f9a176ba8"),
    await attack("O2-qr-remit-001"),
    await attack("O5-ceo-boarding-001"),
    await attack("O5-ceo-boarding-001-f2bee8350"),
    await attack("O5-ceo-split-001"),
    await run(controlScenario()),
    await run(realisticControl()),
    await run(verifiedBankChangeTwin()),
    await run(smsBankChangeTwin()),
    await run(ticketTwin()),
    await run(fxSkewTwin()),
    await run(chatCeoTwin()),
    await run(voicemailCeoTwin()),
  ];

  it("keeps held-out classes, their twins, every control and whole seed families out of training", async () => {
    const all = await episodes();
    const rows = all.flatMap((e, i) => rowsOf(e, `e${i}`));
    const parts = familyParts(rows);
    // A fresh variant goes wherever its seed goes.
    expect(parts.get("O1-lookalike-domain-001")).toBe("train");
    expect(rows.find((r) => r.scenarioId === "O2-unapproved-invoice-001-f9a176ba8")!.family).toBe(
      "O2-unapproved-invoice-001",
    );
    for (const row of rows) {
      const part = parts.get(row.family)!;
      if (row.offchainClass === null || ["O2", "O5"].includes(row.offchainClass))
        expect(part, row.scenarioId).not.toBe("train");
      else expect(part, row.scenarioId).toBe("train");
    }
    // Both held-out parts get attacks of each held-out class.
    for (const cls of ["O2", "O5"]) {
      const families = new Set(
        rows.filter((r) => r.kind === "attack" && r.offchainClass === cls).map((r) => r.family),
      );
      expect(new Set([...families].map((f) => parts.get(f)))).toEqual(
        new Set(["calibration", "test"]),
      );
    }

    const dataset = buildPaymentsDataset({ rows });
    expect(dataset.train.length).toBeGreaterThan(0);
    expect(dataset.calibration.length).toBeGreaterThan(0);
    expect(dataset.test.length).toBeGreaterThan(0);
    for (const c of dataset.train) {
      expect(c.classes.some((k) => ["O2", "O5", "control"].includes(k))).toBe(false);
      expect(c.split).toBe("train");
    }
    const familiesOf = (cases: { families: string[] }[]) =>
      new Set(cases.flatMap((c) => c.families));
    const train = familiesOf(dataset.train);
    const calibration = familiesOf(dataset.calibration);
    const test = familiesOf(dataset.test);
    for (const f of calibration) expect(test.has(f) || train.has(f)).toBe(false);
    for (const f of test) expect(train.has(f)).toBe(false);
    expect(dataset.test.some((c) => c.manipulated)).toBe(true);
    expect(dataset.calibration.some((c) => c.manipulated)).toBe(true);
    expect(dataset.test.some((c) => c.group === "control" || c.group.startsWith("twin:"))).toBe(
      true,
    );
    // Laya's format, with the v3 questions.
    const gold = JSON.parse(dataset.train[0]!.gold) as Record<string, unknown>;
    expect(Object.keys(gold).sort()).toEqual(["injection_in_inputs", "manipulated"]);
    expect(dataset.manifest.heldOutClasses).toEqual(["O2", "O5"]);
  });

  it("refuses a held-out class, a control, or a seed family or state in two parts", () => {
    const c = (id: string, families: string[], classes: string[]) => ({ id, families, classes });
    const empty = { train: [], calibration: [], test: [] };
    expect(() => assertPaymentSplits({ ...empty, train: [c("a", ["O2-x"], ["O2"])] })).toThrow(
      /held-out class/,
    );
    expect(() => assertPaymentSplits({ ...empty, train: [c("a", ["ctl"], ["control"])] })).toThrow(
      /held-out class or control/,
    );
    expect(() =>
      assertPaymentSplits({
        ...empty,
        calibration: [c("a", ["O2-x"], ["O2"])],
        test: [c("b", ["O2-x"], ["O2"])],
      }),
    ).toThrow(/seed family O2-x/);
    expect(() =>
      assertPaymentSplits({
        ...empty,
        calibration: [c("a", ["O2-x"], ["O2"])],
        test: [c("a", ["O2-y"], ["O2"])],
      }),
    ).toThrow(/input state a/);
  });
});

describe("deduplication", () => {
  it("merges identical states, keeps a shared state only in the most held-out part, and rejects contradictions", async () => {
    const [first, ...rest] = rowsOf(await attack("O1-lookalike-domain-001"));
    const rows = [
      first!,
      // The same state again in the same family: one case with two copies.
      { ...first!, id: "again" },
      // The same state in a held-out O2 episode: it stays there and leaves training.
      moved(first!, { family: "O2-split-invoice-001", offchainClass: "O2", attackClass: "O2" }),
      ...rest,
    ];
    const dataset = buildPaymentsDataset({ rows });
    const all = [...dataset.train, ...dataset.calibration, ...dataset.test];
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    const shared = all.filter((c) => c.families.includes("O2-split-invoice-001"));
    expect(shared).toHaveLength(1);
    expect(shared[0]!.part).not.toBe("train");
    expect(dataset.manifest.droppedSharedState).toBe(2);

    const contradictory = buildPaymentsDataset({
      rows: [
        ...rest,
        {
          ...rest[0]!,
          id: "flip",
          labels: { ...rest[0]!.labels, manipulated: !rest[0]!.labels.manipulated },
        },
      ],
    });
    expect(contradictory.manifest.rejectedConflicting).toEqual({ cases: 1, rows: 2 });
    expect(contradictory.train).toHaveLength(dataset.train.length - 1);
  });

  it("gives each part a hash that doesn't depend on row order and changes with a label", async () => {
    const rows = [
      ...rowsOf(await attack("O1-lookalike-domain-001"), "a"),
      ...rowsOf(await attack("O2-split-invoice-001"), "b"),
      ...rowsOf(await run(controlScenario()), "c"),
    ];
    const one = buildPaymentsDataset({ rows });
    const two = buildPaymentsDataset({ rows: [...rows].reverse() });
    expect(two.manifest.hashes).toEqual(one.manifest.hashes);
    expect(partHash(one.test)).toBe(one.manifest.hashes.test);
    const flipped = one.test.map((c, i) => (i === 0 ? { ...c, manipulated: !c.manipulated } : c));
    expect(partHash(flipped)).not.toBe(one.manifest.hashes.test);
  });
});

describe("sampling the benign training cases", () => {
  it("keeps every manipulated case and leaves calibration and the final test untouched", async () => {
    const rows = [
      ...rowsOf(await attack("O1-lookalike-domain-001"), "a"),
      ...rowsOf(await attack("O1-lookalike-domain-001", false), "b"),
      ...rowsOf(await attack("O2-split-invoice-001"), "c"),
      ...rowsOf(await run(controlScenario()), "d"),
      ...rowsOf(await run(verifiedBankChangeTwin()), "e"),
    ];
    const whole = buildPaymentsDataset({ rows });
    const sampled = buildPaymentsDataset({ rows, trainBenignKeep: 0.5 });
    expect(sampled.calibration).toEqual(whole.calibration);
    expect(sampled.test).toEqual(whole.test);
    expect(sampled.manifest.hashes.calibration).toBe(whole.manifest.hashes.calibration);
    expect(sampled.manifest.hashes.test).toBe(whole.manifest.hashes.test);
    const manipulated = (cases: { manipulated: boolean; id: string }[]) =>
      cases.filter((c) => c.manipulated).map((c) => c.id);
    expect(manipulated(sampled.train)).toEqual(manipulated(whole.train));
    const benign = whole.train.filter((c) => !c.manipulated).length;
    expect(whole.manifest.trainBenignSample).toEqual({ keep: 1, kept: benign, dropped: 0 });
    const { kept, dropped } = sampled.manifest.trainBenignSample;
    expect(kept).toBe(sampled.train.filter((c) => !c.manipulated).length);
    expect(kept + dropped).toBe(benign);
    // The same cases every build, whatever the row order.
    const again = buildPaymentsDataset({ rows: [...rows].reverse(), trainBenignKeep: 0.5 });
    expect(again.train.map((c) => c.id)).toEqual(sampled.train.map((c) => c.id));
    expect(again.manifest.hashes.train).toBe(sampled.manifest.hashes.train);
  });

  it("keeps about the share asked for, by case id, and refuses held-out cases or a bad share", () => {
    const cases = Array.from(
      { length: 2000 },
      (_, i) => ({ id: `case-${i}`, part: "train", manipulated: false }) as PaymentCase,
    );
    const { kept, dropped } = sampleBenignTraining(cases, 0.3);
    expect(kept.length / cases.length).toBeGreaterThan(0.27);
    expect(kept.length / cases.length).toBeLessThan(0.33);
    expect(kept.length + dropped).toBe(cases.length);
    expect(sampleBenignTraining(cases, 1).dropped).toBe(0);
    // A case's fate depends on its id alone.
    const first = sampleBenignTraining(cases.slice(0, 100), 0.3).kept.map((c) => c.id);
    expect(first).toEqual(kept.filter((c) => Number(c.id.slice(5)) < 100).map((c) => c.id));
    for (const share of [0, -0.1, 1.5, Number.NaN])
      expect(() => sampleBenignTraining(cases, share)).toThrow(/must be in/);
    expect(() =>
      sampleBenignTraining([{ ...cases[0]!, part: "test" } as PaymentCase], 0.5),
    ).toThrow(/held-out parts/);
  });
});

describe("the output folder", () => {
  it("must be outside the repo or under an ignored datasets/ or ratings/ folder", () => {
    expect(() => assertDatasetDir("datasets/sentinel-payments")).not.toThrow();
    expect(() => assertDatasetDir(join(tmpdir(), "x"))).not.toThrow();
    expect(() => assertDatasetDir("src/cases")).toThrow(/stay private/);
  });
});
