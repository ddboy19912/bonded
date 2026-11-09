import { readFileSync, statSync } from "node:fs";
import {
  bytesToHex,
  hashMessage,
  hashTypedData,
  type Hex,
  hexToBytes,
  isAddressEqual,
  type LocalAccount,
  recoverAddress,
  serializeSignature,
} from "viem";
import { privateKeyToAccount, publicKeyToAddress, toAccount } from "viem/accounts";

/** secp256k1's order, and half of it: Ethereum only accepts the lower of the two `s` values. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N / 2n;
/** The DER object id of secp256k1 (1.3.132.0.10), as it appears in a public key. */
const SECP256K1_OID = "06052b8104000a";

/**
 * A key held somewhere that signs 32-byte digests and never hands the key out: a cloud KMS or
 * an HSM. Its key must be secp256k1 (AWS `ECC_SECG_P256K1`, Google `EC_SIGN_SECP256K1_SHA256`).
 */
export interface DigestSigner {
  /** The public key as DER SubjectPublicKeyInfo bytes, or PEM text. */
  publicKey(): Promise<Uint8Array | string>;
  /** Signs the 32 bytes as they are (no hashing); returns a DER ECDSA signature. */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

/**
 * A viem account backed by a key that signs digests (`DigestSigner`): the key never comes into
 * this process. It signs typed data and messages; it refuses transactions, which the x402 signer
 * never needs.
 */
export async function digestSignerAccount(key: DigestSigner): Promise<LocalAccount> {
  const address = publicKeyToAddress(uncompressedKey(await key.publicKey()));
  const sign = async (hash: Hex): Promise<Hex> => {
    const der = await key.signDigest(hexToBytes(hash));
    const { r, s } = parseDerSignature(der);
    const low = s > HALF_N ? N - s : s;
    for (const yParity of [0, 1]) {
      const signature = serializeSignature({ r: toWord(r), s: toWord(low), yParity });
      if (isAddressEqual(await recoverAddress({ hash, signature }), address)) return signature;
    }
    throw new Error("the key's signature doesn't match its public key");
  };
  return toAccount({
    address,
    signMessage: ({ message }) => sign(hashMessage(message)),
    signTypedData: (typedData) => sign(hashTypedData(typedData)),
    signTransaction: async () => {
      throw new Error("this account signs x402 payments only, not transactions");
    },
  });
}

/** What `awsKms` needs from `@aws-sdk/client-kms`: a `KMSClient` (pass your own to set credentials). */
export interface AwsKmsClient {
  send(command: unknown): Promise<unknown>;
}

/**
 * A key in AWS KMS (key spec `ECC_SECG_P256K1`, usage `SIGN_VERIFY`). The signer's role needs
 * `kms:GetPublicKey` and `kms:Sign` on that key only. Needs `@aws-sdk/client-kms`.
 */
export async function awsKms(options: {
  keyId: string;
  region?: string;
  client?: AwsKmsClient;
}): Promise<DigestSigner> {
  const sdk = await import("@aws-sdk/client-kms");
  const client: AwsKmsClient =
    options.client ?? new sdk.KMSClient(options.region ? { region: options.region } : {});
  return {
    async publicKey() {
      const out = (await client.send(new sdk.GetPublicKeyCommand({ KeyId: options.keyId }))) as {
        PublicKey?: Uint8Array;
        KeySpec?: string;
      };
      if (out.KeySpec && out.KeySpec !== "ECC_SECG_P256K1")
        throw new Error(`AWS KMS key ${options.keyId} is ${out.KeySpec}, not ECC_SECG_P256K1`);
      if (!out.PublicKey) throw new Error(`AWS KMS sent no public key for ${options.keyId}`);
      return out.PublicKey;
    },
    async signDigest(digest) {
      const out = (await client.send(
        new sdk.SignCommand({
          KeyId: options.keyId,
          Message: digest,
          MessageType: "DIGEST",
          SigningAlgorithm: "ECDSA_SHA_256",
        }),
      )) as { Signature?: Uint8Array };
      if (!out.Signature) throw new Error(`AWS KMS sent no signature for ${options.keyId}`);
      return out.Signature;
    },
  };
}

/** What `googleKms` needs from `@google-cloud/kms`'s `KeyManagementServiceClient`. */
export interface GoogleKmsClient {
  getPublicKey(request: {
    name: string;
  }): Promise<[{ pem?: string | null; algorithm?: unknown }, ...unknown[]]>;
  asymmetricSign(request: {
    name: string;
    digest: { sha256: Uint8Array };
  }): Promise<[{ signature?: Uint8Array | string | null }, ...unknown[]]>;
}

/**
 * A key version in Google Cloud KMS (algorithm `EC_SIGN_SECP256K1_SHA256`), named
 * `projects/…/locations/…/keyRings/…/cryptoKeys/…/cryptoKeyVersions/1`. The signer's service
 * account needs `cloudkms.cryptoKeyVersions.useToSign` and `viewPublicKey` on it only. Needs
 * `@google-cloud/kms`.
 */
export async function googleKms(options: {
  keyName: string;
  client?: GoogleKmsClient;
}): Promise<DigestSigner> {
  const client: GoogleKmsClient =
    options.client ??
    (new (
      await import("@google-cloud/kms")
    ).KeyManagementServiceClient() as unknown as GoogleKmsClient);
  return {
    async publicKey() {
      const [key] = await client.getPublicKey({ name: options.keyName });
      if (!key.pem) throw new Error(`Google KMS sent no public key for ${options.keyName}`);
      return key.pem;
    },
    async signDigest(digest) {
      // The digest field is named sha256, but KMS signs the 32 bytes it's given.
      const [out] = await client.asymmetricSign({
        name: options.keyName,
        digest: { sha256: digest },
      });
      if (!out.signature) throw new Error(`Google KMS sent no signature for ${options.keyName}`);
      return typeof out.signature === "string"
        ? Uint8Array.from(Buffer.from(out.signature, "base64"))
        : out.signature;
    },
  };
}

/**
 * A key in a file: `0x` and 64 hex digits. The file must be readable by its owner only (`chmod
 * 600`). Simplest to run, but anyone who can read the file can move the money: keep it on a
 * machine the agent can't reach, or use a KMS.
 */
export function keyFileAccount(path: string): LocalAccount {
  const mode = statSync(path).mode;
  if (process.platform !== "win32" && (mode & 0o077) !== 0)
    throw new Error(`${path} can be read by other users; run chmod 600 on it`);
  const key = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${path} must hold 0x and 64 hex digits`);
  return privateKeyToAccount(key as Hex);
}

/** The 65-byte uncompressed public key (0x04, x, y) inside a secp256k1 SubjectPublicKeyInfo. */
export function uncompressedKey(spki: Uint8Array | string): Hex {
  const der =
    typeof spki === "string"
      ? Uint8Array.from(
          Buffer.from(
            spki.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, ""),
            "base64",
          ),
        )
      : spki;
  const hex = bytesToHex(der);
  if (!hex.includes(SECP256K1_OID)) throw new Error("the key isn't secp256k1");
  if (der.length < 65 || der[der.length - 65] !== 0x04)
    throw new Error("the public key isn't an uncompressed secp256k1 key");
  return bytesToHex(der.slice(der.length - 65));
}

/** `r` and `s` from a DER ECDSA signature: SEQUENCE { INTEGER r, INTEGER s }. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const byte = () => {
    if (i >= der.length) throw new Error("the DER signature is cut short");
    return der[i++]!;
  };
  const length = () => {
    const first = byte();
    if (first < 0x80) return first;
    if (first !== 0x81) throw new Error("the DER signature is too long");
    return byte();
  };
  const integer = () => {
    if (byte() !== 0x02) throw new Error("the DER signature has no integer where one belongs");
    const n = length();
    if (n === 0 || n > 33 || i + n > der.length)
      throw new Error("the DER signature's integer is malformed");
    const value = BigInt(bytesToHex(der.slice(i, i + n)));
    i += n;
    return value;
  };
  if (byte() !== 0x30) throw new Error("not a DER signature");
  const total = length();
  if (i + total !== der.length) throw new Error("the DER signature's length is wrong");
  const r = integer();
  const s = integer();
  if (i !== der.length) throw new Error("the DER signature has extra bytes");
  if (r === 0n || r >= N || s === 0n || s >= N)
    throw new Error("the DER signature is out of range");
  return { r, s };
}

const toWord = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
