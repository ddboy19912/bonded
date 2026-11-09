import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { type Hex, hexToBytes, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  awsKms,
  digestSignerAccount,
  type DigestSigner,
  googleKms,
  keyFileAccount,
  parseDerSignature,
  uncompressedKey,
} from "../src/keys.js";
import { payment } from "./helpers.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SPKI_PREFIX = "3056301006072a8648ce3d020106052b8104000a034200";
const P256_SPKI_PREFIX = "3059301306072a8648ce3d020106082a8648ce3d030107034200";

function derInteger(n: bigint): string {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  if (parseInt(hex.slice(0, 2), 16) >= 0x80) hex = `00${hex}`;
  return `02${(hex.length / 2).toString(16).padStart(2, "0")}${hex}`;
}

function der(r: bigint, s: bigint): Uint8Array {
  const body = derInteger(r) + derInteger(s);
  return hexToBytes(`0x30${(body.length / 2).toString(16).padStart(2, "0")}${body}`);
}

/** A stand-in KMS: holds a key, signs digests in DER, and returns the high `s` half the time. */
function fakeKms(highS = false) {
  const privateKey = generatePrivateKey();
  const local = privateKeyToAccount(privateKey);
  const spki = hexToBytes(`0x${SPKI_PREFIX}${local.publicKey.slice(2)}`);
  const signer: DigestSigner = {
    publicKey: async () => spki,
    signDigest: async (digest) => {
      const { r, s } = await sign({
        hash: `0x${Buffer.from(digest).toString("hex")}`,
        privateKey,
        to: "object",
      });
      const sBig = BigInt(s);
      return der(BigInt(r), highS ? N - sBig : sBig);
    },
  };
  return { local, spki, signer };
}

async function checks(account: Awaited<ReturnType<typeof digestSignerAccount>>) {
  const p = payment(account.address);
  const typedData = {
    domain: p.domain,
    types: p.types,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      ...p.message,
      value: 1000n,
      validAfter: 0n,
      validBefore: BigInt(p.message.validBefore as string),
    } as never,
  };
  const signature = await account.signTypedData(typedData);
  return verifyTypedData({ address: account.address, ...typedData, signature });
}

describe("digestSignerAccount", () => {
  it("signs typed data with a key it never sees", async () => {
    const { local, signer } = fakeKms();
    const account = await digestSignerAccount(signer);
    expect(account.address).toBe(local.address);
    expect(await checks(account)).toBe(true);
  });

  it("turns a high s into the low one Ethereum accepts", async () => {
    const account = await digestSignerAccount(fakeKms(true).signer);
    for (let i = 0; i < 3; i++) expect(await checks(account)).toBe(true);
  });

  it("refuses transactions", async () => {
    const account = await digestSignerAccount(fakeKms().signer);
    await expect(
      account.signTransaction({ to: account.address, chainId: 1, gas: 21_000n, maxFeePerGas: 1n }),
    ).rejects.toThrow(/x402 payments only/);
  });

  it("reads PEM public keys and refuses other curves", () => {
    const { local, spki } = fakeKms();
    const pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spki).toString("base64")}\n-----END PUBLIC KEY-----\n`;
    expect(uncompressedKey(pem)).toBe(local.publicKey);
    const p256 = hexToBytes(`0x${P256_SPKI_PREFIX}${local.publicKey.slice(2)}`);
    expect(() => uncompressedKey(p256)).toThrow(/secp256k1/);
  });
});

describe("parseDerSignature", () => {
  it("reads r and s", () => {
    expect(parseDerSignature(der(5n, 7n))).toEqual({ r: 5n, s: 7n });
    expect(parseDerSignature(der(N - 1n, 1n << 255n))).toEqual({ r: N - 1n, s: 1n << 255n });
  });
  it("refuses malformed signatures", () => {
    const good = der(5n, 7n);
    expect(() => parseDerSignature(good.slice(0, -1))).toThrow();
    expect(() => parseDerSignature(new Uint8Array([...good, 0]))).toThrow();
    expect(() => parseDerSignature(der(0n, 7n))).toThrow();
    expect(() => parseDerSignature(der(N, 7n))).toThrow();
    expect(() => parseDerSignature(new Uint8Array([0x31, 0]))).toThrow();
  });
});

describe("awsKms", () => {
  it("asks KMS for the public key and for digest signatures", async () => {
    const { local, spki, signer } = fakeKms();
    const sent: unknown[] = [];
    const client = {
      async send(command: unknown) {
        sent.push(command);
        if (command instanceof GetPublicKeyCommand)
          return { PublicKey: spki, KeySpec: "ECC_SECG_P256K1" };
        if (command instanceof SignCommand) {
          expect(command.input.MessageType).toBe("DIGEST");
          expect(command.input.SigningAlgorithm).toBe("ECDSA_SHA_256");
          return { Signature: await signer.signDigest(command.input.Message as Uint8Array) };
        }
        throw new Error("unexpected command");
      },
    };
    const account = await digestSignerAccount(await awsKms({ keyId: "alias/agent", client }));
    expect(account.address).toBe(local.address);
    expect(await checks(account)).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a key that isn't secp256k1", async () => {
    const client = {
      send: async () => ({ PublicKey: new Uint8Array(91), KeySpec: "ECC_NIST_P256" }),
    };
    await expect(digestSignerAccount(await awsKms({ keyId: "k", client }))).rejects.toThrow(
      /ECC_SECG_P256K1/,
    );
  });
});

describe("googleKms", () => {
  it("reads the PEM key and signs digests", async () => {
    const { local, spki, signer } = fakeKms();
    const pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spki).toString("base64")}\n-----END PUBLIC KEY-----\n`;
    const client = {
      getPublicKey: async () => [{ pem }] as [{ pem: string }],
      asymmetricSign: async (req: { digest: { sha256: Uint8Array } }) =>
        [
          { signature: Buffer.from(await signer.signDigest(req.digest.sha256)).toString("base64") },
        ] as [{ signature: string }],
    };
    const account = await digestSignerAccount(
      await googleKms({ keyName: "projects/p/k/1", client }),
    );
    expect(account.address).toBe(local.address);
    expect(await checks(account)).toBe(true);
  });
});

describe("keyFileAccount", () => {
  const write = (key: Hex | string, mode: number) => {
    const path = join(mkdtempSync(join(tmpdir(), "bonded-signer-")), "key");
    writeFileSync(path, `${key}\n`);
    chmodSync(path, mode);
    return path;
  };

  it("reads a key only its owner can read", () => {
    const key = generatePrivateKey();
    expect(keyFileAccount(write(key, 0o600)).address).toBe(privateKeyToAccount(key).address);
  });

  it("refuses a file others can read, or one that isn't a key", () => {
    expect(() => keyFileAccount(write(generatePrivateKey(), 0o644))).toThrow(/chmod 600/);
    expect(() => keyFileAccount(write("hello", 0o600))).toThrow(/64 hex/);
  });
});
