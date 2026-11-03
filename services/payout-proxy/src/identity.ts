import { createECDH, createHash, type ECDH } from "node:crypto";
import {
  openPayoutCredential,
  payoutResultMessage,
  payoutSealKeyMessage,
  teeReportData,
  type PayoutCredential,
  type PayoutResult,
  type SealedPayoutCredential,
  type TeeEvidence,
} from "@bondedhq/shared";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TeeBackend } from "./backend.js";

/**
 * The proxy's identity: an EVM key that signs its answers and a P-256 seal key credentials are
 * sealed to, both derived inside the TEE, and the code it runs. The private keys live only in
 * this object's closure; no route returns them.
 */
export class ProxyIdentity {
  private constructor(
    private readonly backend: TeeBackend,
    readonly codeHash: Hex,
    readonly evmAddress: Hex,
    /** P-256, uncompressed, 65 bytes. */
    readonly sealPublicKey: Hex,
    /** The EVM key's signature of `payoutSealKeyMessage`. */
    readonly sealKeySignature: Hex,
    private readonly keys: { evm: ReturnType<typeof privateKeyToAccount>; seal: ECDH },
  ) {}

  static async create(backend: TeeBackend, codeHash: string): Promise<ProxyIdentity> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(codeHash))
      throw new Error("CODE_HASH must be 0x followed by 64 hex digits");
    const evm = privateKeyToAccount(bytesToHex(await backend.evmKey()));
    const seal = sealKeyFrom(await backend.sealSeed());
    const sealPublicKey = bytesToHex(seal.getPublicKey());
    const code = codeHash.toLowerCase() as Hex;
    const signature = await evm.signMessage({ message: payoutSealKeyMessage(code, sealPublicKey) });
    return new ProxyIdentity(backend, code, evm.address, sealPublicKey, signature, { evm, seal });
  }

  /**
   * Evidence for one challenge: a fresh quote whose report data commits to this code, the EVM
   * key and the caller's nonce (`teeReportData`, with no Solana key). The seal key is tied to the
   * EVM key by `sealKeySignature`.
   */
  async attest(nonce: string): Promise<TeeEvidence> {
    const reportData = teeReportData({
      codeHash: this.codeHash,
      evmAddress: this.evmAddress,
      nonce,
    });
    const { quote, eventLog } = await this.backend.quote(hexToBytes(reportData));
    return {
      quote: `0x${quote.replace(/^0x/, "")}`,
      eventLog,
      composeHash: (await this.backend.composeHash()).replace(/^0x/, ""),
      codeHash: this.codeHash,
      evmAddress: this.evmAddress,
      nonce: nonce.startsWith("0x") ? nonce : `0x${nonce}`,
    };
  }

  /** Open a credential sealed to this proxy for `gateAccountId`. Throws if it doesn't open. */
  open(sealed: SealedPayoutCredential, gateAccountId: string): Promise<PayoutCredential> {
    if (sealed.to.toLowerCase() !== this.sealPublicKey.toLowerCase())
      throw new Error("sealed to another key");
    return openPayoutCredential(sealed, gateAccountId, (epk) =>
      this.keys.seal.computeSecret(Buffer.from(epk)),
    );
  }

  /** Sign an answer, so the API can tell it came from the attested key. */
  signResult(result: PayoutResult): Promise<Hex> {
    return this.keys.evm.signMessage({ message: payoutResultMessage(result) });
  }
}

/**
 * A P-256 key from 32 derived bytes. A scalar outside the curve's order is vanishingly rare;
 * then the bytes are hashed again, so the same bytes always give the same key.
 */
function sealKeyFrom(seed: Uint8Array): ECDH {
  let bytes = Buffer.from(seed);
  for (let i = 0; i < 16; i++) {
    const ecdh = createECDH("prime256v1");
    try {
      ecdh.setPrivateKey(bytes);
      return ecdh;
    } catch {
      bytes = createHash("sha256").update(bytes).digest();
    }
  }
  throw new Error("no seal key could be made from the derived bytes");
}
