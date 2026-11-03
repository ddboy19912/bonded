import {
  bytesToHex,
  hexToBytes,
  isAddressEqual,
  recoverMessageAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson } from "./canonical.js";
import type { SignedGateReceipt } from "./gate-receipt.js";

/**
 * The payment gate's payout route (Phase 5b): the pieces the gate API and the payout proxy (a
 * small service in a TEE, services/payout-proxy) share. The agent never holds the payout
 * credential. The owner's provider key is sealed to a key made inside the TEE (`sealPayoutCredential`),
 * so only that service can open it; the API stores the sealed copy and sends it along with every
 * payout. The proxy pays only when the instruction carries a gate receipt that allows exactly that
 * payee, amount and reference.
 *
 * Sealing is ECDH on P-256 with a fresh key per seal, HKDF-SHA256 and AES-256-GCM, through
 * WebCrypto (Node 22 and browsers alike), so an owner can seal in their own browser or script.
 * The gate account's id is the AES-GCM associated data: a sealed credential opens only for the
 * account it was sealed for.
 */

/** The providers a payout can go through. A payee names its provider: "stripe:...". */
export const PAYOUT_PROVIDERS = ["stripe"] as const;
export type PayoutProviderName = (typeof PAYOUT_PROVIDERS)[number];

/** What is sealed: a provider credential, bound to one gate account. */
export interface PayoutCredential {
  provider: PayoutProviderName;
  gateAccountId: string;
  /** The provider's API key (Stripe: a restricted `rk_test_...` key). */
  secretKey: string;
  /** Where payouts are paid from (Stripe: the financial account, `fa_...`). */
  financialAccount: string;
}

/** A credential sealed to a payout proxy's key. Holds nothing readable without that key. */
export interface SealedPayoutCredential {
  v: 1;
  /** The proxy's seal key it was sealed to (P-256, uncompressed, 65 bytes). */
  to: Hex;
  /** The one-time public key of this seal. */
  epk: Hex;
  iv: Hex;
  /** AES-256-GCM ciphertext with its 16-byte tag. */
  ct: Hex;
}

export const PAYOUT_SEAL_INFO = "bonded-gate-payout-seal-v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const buf = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;
const associated = (gateAccountId: string) => encoder.encode(`bonded-gate-payout:${gateAccountId}`);
const HEX = /^0x[0-9a-fA-F]*$/;

/** Whether a provider key is a test-mode one (Stripe: `sk_test_`, `rk_test_`). */
export const isTestPayoutKey = (secretKey: string) => /^(rk|sk)_test_/.test(secretKey);
/** Whether a provider key is a live one. Anything neither test nor live is refused. */
export const isLivePayoutKey = (secretKey: string) => /^(rk|sk)_live_/.test(secretKey);

/** A key's first characters and last four, to tell keys apart without showing them. */
export const payoutKeyHint = (secretKey: string) =>
  `${secretKey.slice(0, 8)}…${secretKey.slice(-4)}`;

async function aesKey(shared: Uint8Array, epk: Uint8Array, to: Uint8Array) {
  const ikm = await subtle().importKey("raw", buf(shared), "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array(epk.length + to.length);
  salt.set(epk, 0);
  salt.set(to, epk.length);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(PAYOUT_SEAL_INFO) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seal a credential to a payout proxy's seal key (from its attested `/seal-key`). */
export async function sealPayoutCredential(
  credential: PayoutCredential,
  sealKey: Hex,
): Promise<SealedPayoutCredential> {
  const to = hexToBytes(sealKey);
  if (to.length !== 65 || to[0] !== 4) throw new Error("a seal key is a 65-byte P-256 public key");
  const recipient = await subtle().importKey(
    "raw",
    buf(to),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const pair = (await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as import("node:crypto").webcrypto.CryptoKeyPair;
  const epk = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  const shared = new Uint8Array(
    await subtle().deriveBits({ name: "ECDH", public: recipient }, pair.privateKey, 256),
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv, additionalData: associated(credential.gateAccountId) },
      await aesKey(shared, epk, to),
      encoder.encode(canonicalJson(credential)),
    ),
  );
  return { v: 1, to: bytesToHex(to), epk: bytesToHex(epk), iv: bytesToHex(iv), ct: bytesToHex(ct) };
}

/** Whether a value has the shape of a sealed credential. */
export function isSealedPayoutCredential(value: unknown): value is SealedPayoutCredential {
  const v = value as Record<string, unknown> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    v.v === 1 &&
    Object.keys(v).length === 5 &&
    ["to", "epk", "iv", "ct"].every((k) => typeof v[k] === "string" && HEX.test(v[k] as string)) &&
    (v.to as string).length === 132 &&
    (v.epk as string).length === 132 &&
    (v.iv as string).length === 26 &&
    (v.ct as string).length <= 8_192
  );
}

/**
 * Open a sealed credential for `gateAccountId`. `ecdh` is the seal key's half of the exchange:
 * the shared secret (the x coordinate, 32 bytes) with the seal's one-time public key. Throws if
 * it was sealed for another account or key, or was changed.
 */
export async function openPayoutCredential(
  sealed: SealedPayoutCredential,
  gateAccountId: string,
  ecdh: (epk: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<PayoutCredential> {
  if (!isSealedPayoutCredential(sealed)) throw new Error("not a sealed credential");
  const epk = hexToBytes(sealed.epk);
  const to = hexToBytes(sealed.to);
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: buf(hexToBytes(sealed.iv)), additionalData: associated(gateAccountId) },
    await aesKey(await ecdh(epk), epk, to),
    buf(hexToBytes(sealed.ct)),
  );
  const credential = JSON.parse(decoder.decode(plain)) as PayoutCredential;
  if (credential.gateAccountId !== gateAccountId) throw new Error("sealed for another account");
  return credential;
}

/**
 * What the API sends the proxy to pay out one decision: the signed receipt (the proxy checks the
 * signature, that it allows the payment, and that `destination` is its payee), where to pay, and
 * the account's sealed credential.
 */
export interface PayoutInstruction {
  receipt: SignedGateReceipt;
  /** The payee as the vendor master writes it: "stripe:<recipient>:<payout method>". */
  destination: string;
  currency: "usd";
  credential: SealedPayoutCredential;
}

/**
 * What the proxy signs with its attested EVM key to vouch for its seal key, so the API can tie
 * the seal key to the code the TEE's quote measured.
 */
export const payoutSealKeyMessage = (codeHash: Hex, sealKey: Hex) =>
  `Bonded payout proxy seal key\ncode: ${codeHash.toLowerCase()}\nkey: ${sealKey.toLowerCase()}`;

/** What the proxy answers about a payout, signed with its attested EVM key. */
export interface PayoutResult {
  /** The gate decision this payout carries out (empty for a lookup). */
  decisionId: string;
  gateAccountId: string;
  provider: PayoutProviderName;
  /** The provider's id for the payout (Stripe: `obp_...`). */
  payoutId: string;
  /** The provider's status: processing, posted, failed, returned or canceled. */
  status: string;
  amountCents: number;
  currency: string;
  /** The payee as "provider:destination", case as the provider gives it. */
  destination: string;
  /** The gate decision the provider's record names (its metadata), if any. */
  gateDecision: string | null;
  livemode: boolean;
}

export const payoutResultMessage = (result: PayoutResult) =>
  `bonded-payout-result-v1:${canonicalJson(result)}`;

/** Whether `signature` is the proxy key `signer`'s signature of `result`. Never throws. */
export async function verifyPayoutResult(
  result: PayoutResult,
  signature: Hex,
  signer: Address,
): Promise<boolean> {
  try {
    const recovered = await recoverMessageAddress({
      message: payoutResultMessage(result),
      signature,
    });
    return isAddressEqual(recovered, signer);
  } catch {
    return false;
  }
}

/**
 * A lookup of one provider payout, signed by the gate's receipt key, for reconciling the
 * provider's events. It moves no money; it lets the proxy say what the provider records.
 */
export interface PayoutLookup {
  gateAccountId: string;
  payoutId: string;
  /** Unix seconds. The proxy refuses one older than five minutes. */
  issuedAt: number;
}

export interface SignedPayoutLookup {
  lookup: PayoutLookup;
  signer: Address;
  signature: Hex;
}

export const PAYOUT_LOOKUP_DOMAIN = { name: "Bonded Payout Proxy", version: "1" } as const;
export const PAYOUT_LOOKUP_TYPES = {
  PayoutLookup: [
    { name: "gateAccountId", type: "string" },
    { name: "payoutId", type: "string" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

const lookupTypedData = (lookup: PayoutLookup) => ({
  domain: PAYOUT_LOOKUP_DOMAIN,
  types: PAYOUT_LOOKUP_TYPES,
  primaryType: "PayoutLookup" as const,
  message: { ...lookup, issuedAt: BigInt(lookup.issuedAt) },
});

export async function signPayoutLookup(
  lookup: PayoutLookup,
  privateKey: Hex,
): Promise<SignedPayoutLookup> {
  const account = privateKeyToAccount(privateKey);
  return {
    lookup,
    signer: account.address,
    signature: await account.signTypedData(lookupTypedData(lookup)),
  };
}

/** Whether a lookup was signed by `expectedSigner`. Never throws. */
export async function verifyPayoutLookup(
  signed: SignedPayoutLookup,
  expectedSigner: Address,
): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress({
      ...lookupTypedData(signed.lookup),
      signature: signed.signature,
    });
    return isAddressEqual(recovered, expectedSigner);
  } catch {
    return false;
  }
}
