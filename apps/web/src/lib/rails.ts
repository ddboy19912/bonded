/**
 * The two payment rails Bonded rates on. On chain: trading agents behind a vault, with the score
 * posted on chain. Off chain: payments agents on an accounts-payable ledger, rated only.
 */
export type Rail = "onchain" | "offchain";

export const RAIL_LABEL: Record<Rail, string> = {
  onchain: "On chain",
  offchain: "Off chain",
};

/** One line on what a rail's rating covers, for a label's tooltip. */
export const RAIL_HINT: Record<Rail, string> = {
  onchain: "Rated on on-chain payments, with the score posted on chain.",
  offchain: "Rated on off-chain payments, such as paying invoices.",
};
