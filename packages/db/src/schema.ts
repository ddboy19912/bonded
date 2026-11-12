import {
  pgTable,
  boolean,
  text,
  integer,
  numeric,
  jsonb,
  uuid,
  timestamp,
  bigserial,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";
const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const agents = pgTable(
  "agents",
  {
    id: text().primaryKey(),
    chainId: integer("chain_id").notNull(),
    agentId: numeric("agent_id", { precision: 78, scale: 0 }).notNull(),
    config: jsonb().notNull(),
    enabled: boolean().notNull().default(true),
  },
  (t) => [unique().on(t.chainId, t.agentId)],
);
export const ratings = pgTable("ratings", {
  id: uuid().primaryKey(),
  /** Null for a preview's rating (0020), which has `previewId` instead. */
  agentId: text("agent_id").references(() => agents.id),
  status: text().notNull().default("queued"),
  report: jsonb(),
  reportJson: text("report_json"),
  attestation: jsonb(),
  error: text(),
  createdAt: created(),
  /** What it was queued under (0018): the registration's kind, the owner charged, the registration. */
  kind: text().notNull().default(""),
  chargedOwner: text("charged_owner"),
  config: jsonb(),
  /** 0020: the preview it rates, the code it rated and where that came from, its progress. */
  previewId: uuid("preview_id"),
  codeHash: text("code_hash"),
  codeSource: text("code_source"),
  progress: jsonb(),
});
/** A preview rating (0020): an agent rated with no vault, bond or registration. */
export const previews = pgTable("previews", {
  id: uuid().primaryKey(),
  chainId: integer("chain_id").notNull(),
  owner: text().notNull(),
  mode: text().notNull(),
  /** 0034: vault or brokerage. */
  world: text().notNull().default("vault"),
  /** 0035: bonded or alpaca, whose tool names a brokerage preview offers. */
  toolNames: text("tool_names").notNull().default("bonded"),
  connection: text().notNull(),
  codeHash: text("code_hash"),
  status: text().notNull().default("created"),
  ratingId: uuid("rating_id"),
  error: text(),
  upgradedTo: text("upgraded_to"),
  createdAt: created(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const attestations = pgTable("attestations", {
  id: uuid()
    .primaryKey()
    .references(() => ratings.id),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  signed: jsonb().notNull(),
  txHash: text("tx_hash").notNull(),
  createdAt: created(),
});
export const quotes = pgTable("quotes", {
  id: uuid().primaryKey(),
  chainId: integer("chain_id").notNull(),
  agentId: text("agent_id").notNull(),
  signed: jsonb().notNull(),
  createdAt: created(),
});
export const jobs = pgTable("jobs", {
  id: uuid()
    .primaryKey()
    .references(() => ratings.id),
  status: text().notNull().default("queued"),
  attempts: integer().notNull().default(0),
  token: uuid(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
});
export const keeperCursors = pgTable(
  "keeper_cursors",
  {
    chainId: integer("chain_id").notNull(),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
    blockHash: text("block_hash").notNull(),
    registry: text("registry").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.registry] })],
);
export const deployments = pgTable("deployments", {
  chainId: integer("chain_id").primaryKey(),
  registry: text("registry").notNull(),
  adoptedAt: timestamp("adopted_at", { withTimezone: true }).notNull().defaultNow(),
});
export const keeperVaults = pgTable(
  "keeper_vaults",
  { chainId: integer("chain_id").notNull(), address: text().notNull() },
  (t) => [primaryKey({ columns: [t.chainId, t.address] })],
);
export const keeperPolicies = pgTable(
  "keeper_policies",
  {
    chainId: integer("chain_id").notNull(),
    policyId: numeric("policy_id", { precision: 78, scale: 0 }).notNull(),
    vault: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.policyId] })],
);
export const handledEvents = pgTable("handled_events", {
  id: text().primaryKey(),
  chainId: integer("chain_id").notNull(),
  vault: text().notNull(),
  breachId: numeric("breach_id", { precision: 78, scale: 0 }).notNull(),
  status: text().notNull().default("pending"),
  txHash: text("tx_hash"),
  error: text(),
});
export const events = pgTable("events", {
  id: bigserial({ mode: "bigint" }).primaryKey(),
  topic: text().notNull(),
  payload: jsonb().notNull(),
  createdAt: created(),
});
export const teeChecks = pgTable("tee_checks", {
  agentId: text("agent_id").primaryKey(),
  status: text().notNull(),
  detail: text(),
  measurement: text(),
  ratedMeasurement: text("rated_measurement"),
  ratedReportHash: text("rated_report_hash"),
  evmAddress: text("evm_address"),
  blockingStatus: text("blocking_status"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
});
export const bounties = pgTable(
  "bounties",
  {
    chainId: integer("chain_id").notNull(),
    submissionId: numeric("submission_id", { precision: 78, scale: 0 }).notNull(),
    hunter: text().notNull(),
    specUri: text("spec_uri").notNull(),
    specYaml: text("spec_yaml").notNull(),
    spec: jsonb().notNull(),
    status: text().notNull().default("validating"),
    verdict: jsonb(),
    txHash: text("tx_hash"),
    broadcastPending: boolean("broadcast_pending").notNull().default(false),
    pendingTxHash: text("pending_tx_hash"),
    error: text(),
    attempts: integer().notNull().default(0),
    token: uuid(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.submissionId] })],
);
