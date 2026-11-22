import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const readme = read("README.md");
const evm = (chainId: number) =>
  JSON.parse(read(`contracts/evm/deployments/${chainId}.json`)) as Record<string, string>;

/** README contract names and their keys in the deployment files. */
const CONTRACTS: Record<string, string> = {
  BondedRegistry: "registry",
  MandateVaultFactory: "factory",
  CoverManager: "coverManager",
  CoverPool: "pool",
  OperatorBond: "bond",
  ClaimsEngine: "claimsEngine",
  BountyBoard: "bountyBoard",
};
/** The README's EVM columns, in order, with each chain's explorer. */
const CHAINS = [
  { chainId: 46630, explorer: "https://explorer.testnet.chain.robinhood.com/address/" },
  { chainId: 421614, explorer: "https://sepolia.arbiscan.io/address/" },
  { chainId: 11155111, explorer: "https://sepolia.etherscan.io/address/" },
];

/** `[`0xabc`](https://…/address/0xabc)` → the displayed address and the linked URL. */
function cell(text: string) {
  const m = /^\[`([^`]+)`\]\(([^)]+)\)$/.exec(text.trim());
  if (!m) throw new Error(`not an address link: ${text}`);
  return { shown: m[1]!, url: m[2]! };
}

function row(name: string): string[] {
  const line = readme.split("\n").find((l) => l.startsWith(`| ${name} |`));
  if (!line) throw new Error(`README has no row for ${name}`);
  return line.split("|").slice(2, -1);
}

describe("README deployment tables", () => {
  it("every EVM address matches its deployment file, in the text and in the explorer link", () => {
    for (const [name, key] of Object.entries(CONTRACTS)) {
      const cells = row(name);
      expect(cells, name).toHaveLength(CHAINS.length);
      CHAINS.forEach(({ chainId, explorer }, i) => {
        const expected = evm(chainId)[key];
        const { shown, url } = cell(cells[i]!);
        expect(shown, `${name} on ${chainId}`).toBe(expected);
        expect(url, `${name} on ${chainId}`).toBe(`${explorer}${expected}`);
      });
    }
  });

  it("every Solana program matches the devnet deployment file", () => {
    const devnet = JSON.parse(read("contracts/solana/deployments/devnet.json")) as {
      programs: Record<string, string>;
    };
    for (const [program, address] of Object.entries(devnet.programs)) {
      const { shown, url } = cell(row(program)[0]!);
      expect(shown, program).toBe(address);
      expect(url, program).toBe(`https://explorer.solana.com/address/${address}?cluster=devnet`);
    }
  });

  it("the owner named in the README is the owner in the deployments README", () => {
    // Since the Oct 22, 2026 key rotation the owner is no longer the deploy key.
    const owner =
      /Owner, attester, dispute council and cover treasury on every EVM testnet: `(0x[0-9a-fA-F]{40})`/.exec(
        readme,
      )?.[1];
    expect(owner).toBeDefined();
    expect(read("contracts/evm/deployments/README.md")).toContain(
      `\`${owner!}\` owns every contract`,
    );
  });
});

describe("links in the main docs", () => {
  const DOCS = [
    "README.md",
    "docs/ARCHITECTURE.md",
    "docs/AGENTS.md",
    "docs/DEVELOPING.md",
    "docs/DEVELOPING-REFERENCE.md",
    "apps/demo-agents/README.md",
  ];
  for (const doc of DOCS) {
    it(`${doc}: every relative link points at a file or folder that exists`, () => {
      const missing: string[] = [];
      for (const [, target] of read(doc).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^(https?:|mailto:|#)/.test(target!)) continue;
        const path = target!.split("#")[0]!;
        if (!existsSync(resolve(ROOT, dirname(doc), path))) missing.push(target!);
      }
      expect(missing).toEqual([]);
    });
  }
});
