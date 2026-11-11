#!/usr/bin/env node
/**
 * pnpm release:check: packs the published packages and installs the tarballs into an empty
 * project, the way a user would get them from npm, then checks they work there:
 * `bonded-runner --version`, `bonded-mcp-config`, and imports of the SDK's entry points (without
 * any optional framework installed). Catches missing files, wrong exports and workspace-only
 * dependencies before they reach npm. Needs the npm registry for third-party dependencies.
 *
 * `--keep` leaves the temporary project in place; `--no-build` uses the existing builds.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackages, PACKAGES, read, ROOT, run, version } from "./packages.mjs";

/** Runs in the temporary project, against the installed tarballs. */
const SMOKE = `
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import * as sdk from "@bondedhq/sdk";
import * as mcp from "@bondedhq/sdk/mcp";
import * as agentUrl from "@bondedhq/sdk/agent-url";
import * as shared from "@bondedhq/shared";
import * as sharedAgentUrl from "@bondedhq/shared/agent-url";
import * as solana from "@bondedhq/solana";
import * as x402 from "@bondedhq/sdk/x402";
import * as signer from "@bondedhq/signer";

for (const name of ["BondedVault", "buildMandate", "fromBondedEnv", "isBondedEpisode", "episodeVault", "guarded"])
  assert.equal(typeof sdk[name], "function", "@bondedhq/sdk exports " + name);
for (const name of ["connectEpisodeTools", "mcpConfig", "finishEpisode", "isBondedEpisode"])
  assert.equal(typeof mcp[name], "function", "@bondedhq/sdk/mcp exports " + name);
assert.equal(typeof shared.parseEpisodeEnv, "function");
// The brokerage world (runner protocol 2).
for (const name of ["fromBondedBrokerageEnv", "bondedEpisodeWorld"])
  assert.equal(typeof sdk[name], "function", "@bondedhq/sdk exports " + name);
assert.equal(typeof shared.parseBrokerageEpisodeEnv, "function");
assert.equal(shared.BROKERAGE_PROTOCOL_VERSION, 2);
assert.equal(typeof sharedAgentUrl.verifyAgentUrlRequest, "function");
assert.ok(solana.PROGRAM_IDS.vault, "@bondedhq/solana loads its IDLs");
for (const name of ["x402Guard", "x402Price", "remoteX402Signer"])
  assert.equal(typeof x402[name], "function", "@bondedhq/sdk/x402 exports " + name);
for (const name of ["x402Signer", "x402SignerHandler", "serveX402Signer"])
  assert.equal(typeof signer[name], "function", "@bondedhq/signer exports " + name);

// The Agent URL handler answers a challenge it can verify, and refuses one it can't.
const secret = "bonded_as_release-check";
const handler = agentUrl.createBondedHandler({ secret, version: "check", onEpisode() {} });
const challenge = "release-check-challenge-0001";
const body = JSON.stringify({ type: "verify", challenge });
const signed = await agentUrl.signBondedRequest(secret, body);
const ok = await handler(new Request("http://x/", { method: "POST", headers: signed, body }));
const answer = await ok.json();
assert.equal(answer.version, "check");
assert.ok(await sharedAgentUrl.checkAgentUrlVerifyProof(secret, challenge, answer), "the answer proves the secret");
const bad = await handler(new Request("http://x/", { method: "POST", headers: { ...signed, "bonded-signature": "v1=" + "0".repeat(64) }, body }));
assert.equal(bad.status, 401);

assert.deepEqual(mcp.mcpConfig({ endpoints: { mcp: "https://gw/e/t/mcp" } }), {
  mcpServers: { "bonded-episode": { type: "http", url: "https://gw/e/t/mcp" } },
});
const cli = spawnSync("npx", ["--no-install", "bonded-mcp-config"], { encoding: "utf8" });
assert.equal(cli.status, 1, "bonded-mcp-config refuses to run outside an episode");
assert.match(cli.stderr, /BONDED_/);

// Framework entry points load only with their framework installed (optional peers).
for (const sub of ["langchain", "ai-sdk"])
  await assert.rejects(import("@bondedhq/sdk/" + sub), /Cannot find (package|module)/);
console.log("smoke: ok");
`;

const keep = process.argv.includes("--keep");
if (!process.argv.includes("--no-build")) buildPackages();

const dir = mkdtempSync(join(tmpdir(), "bonded-release-check-"));
try {
  const tarballs = {};
  for (const pkg of PACKAGES) {
    run("pnpm", ["pack", "--pack-destination", dir], { cwd: join(ROOT, pkg.dir), stdio: "ignore" });
    const file = `${pkg.name.replace("@", "").replace("/", "-")}-${version(pkg)}.tgz`;
    tarballs[pkg.name] = `file:./${file}`;
  }
  const project = join(dir, "project");
  mkdirSync(project);
  // Every Bonded package from its tarball, also where one depends on another (overrides), and
  // nothing from this workspace.
  const fromTarball = Object.fromEntries(
    Object.entries(tarballs).map(([name, spec]) => [name, spec.replace("./", "../")]),
  );
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify(
      {
        name: "bonded-release-check",
        private: true,
        type: "module",
        dependencies: fromTarball,
        overrides: fromTarball,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(project, "smoke.mjs"), SMOKE);
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: project });

  const runner = read("npx", ["--no-install", "bonded-runner", "--version"], { cwd: project });
  const expected = version(PACKAGES.find((p) => p.name === "@bondedhq/runner"));
  if (runner !== expected) {
    console.error(`bonded-runner --version printed ${runner}, expected ${expected}`);
    process.exit(1);
  }
  console.log(`bonded-runner --version: ${runner}`);
  run("node", ["smoke.mjs"], { cwd: project });
  console.log("release check: ok");
} finally {
  if (keep) console.log(`kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
