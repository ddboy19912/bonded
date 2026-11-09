import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root. */
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The packages Bonded publishes to npm, in publish order: each depends only on those before it
 * (`workspace:^` ranges become `^<version>` in the published manifest).
 */
export const PACKAGES = [
  { name: "@bondedhq/shared", dir: "packages/shared" },
  { name: "@bondedhq/solana", dir: "packages/solana" },
  { name: "@bondedhq/sdk", dir: "packages/sdk" },
  { name: "@bondedhq/signer", dir: "packages/signer" },
  { name: "@bondedhq/runner", dir: "apps/runner" },
];

export function version(pkg) {
  return JSON.parse(readFileSync(join(ROOT, pkg.dir, "package.json"), "utf8")).version;
}

/** Runs a command, streaming its output; exits the script if it fails. */
export function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.status !== 0) {
    console.error(
      `\n${command} ${args.join(" ")} failed (exit ${result.status ?? result.signal}).`,
    );
    process.exit(1);
  }
}

/** A command's trimmed stdout, or undefined if it fails. */
export function read(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Fresh builds of the published packages (and what they depend on), with no stale files. */
export function buildPackages() {
  for (const pkg of PACKAGES) rmSync(join(ROOT, pkg.dir, "dist"), { recursive: true, force: true });
  run("pnpm", ["turbo", "run", "build", "--force", ...PACKAGES.map((p) => `--filter=${p.name}`)]);
}
