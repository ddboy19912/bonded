/**
 * The two payment rails Bonded rates on. On chain: trading agents behind a vault, with a bond
 * behind the score. Off chain: payments agents on an accounts-payable ledger, rated, not insured.
 */
export type Rail = "onchain" | "offchain";

export const RAIL_LABEL: Record<Rail, string> = {
  onchain: "On chain",
  offchain: "Off chain",
};

/** One line on what a rail's rating covers, for a label's tooltip. */
export const RAIL_HINT: Record<Rail, string> = {
  onchain: "Rated on on-chain payments, with a bond behind the score.",
  offchain: "Rated on off-chain payments: rated, not insured.",
};
