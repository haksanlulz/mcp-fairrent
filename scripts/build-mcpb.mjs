#!/usr/bin/env node
/**
 * Build the .mcpb bundle — the one-click install channel.
 *
 * Every tool here needs a free HUD token, so today a non-developer has to read
 * the README, sign up at huduser.gov, and hand-edit an MCP client's JSON config
 * to put the token in an `env` block. That is this server's whole adoption
 * barrier. A bundle declares the token as required, sensitive user_config, and
 * the host collects it in its own UI and injects it at launch.
 *
 * Staged rather than packed in place: `mcpb pack .` would ship the dev
 * toolchain (vitest, typescript, tsx) and the tests. The stage is the compiled
 * server, the one runtime dependency, and the manifest.
 *
 * Run: npm run build:mcpb
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
const ok = (m) => console.log(`  ok  ${m}`);
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, shell: true, stdio: "inherit" });

const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8"));

// Two files now carry the version, which is two files that can disagree. The
// bundle a host installs would then report a version the package never had.
if (manifest.version !== pkg.version) {
  fail(`manifest.json version ${manifest.version} != package.json version ${pkg.version}`);
}
ok(`manifest and package agree on ${pkg.version}`);

if (run("npm", ["run", "build"], repo).status !== 0) fail("npm run build");
if (!existsSync(join(repo, "dist", "index.js"))) fail("build produced no dist/index.js");

const out = join(repo, "build");
const stage = join(out, "mcpb");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// entry_point is a path INSIDE the bundle, so the compiled server lands where
// the manifest says it will rather than wherever tsc happened to put it.
const entry = manifest.server?.entry_point;
if (typeof entry !== "string" || !entry.includes("/")) fail(`manifest server.entry_point is not a bundle path: ${entry}`);
cpSync(join(repo, "dist"), join(stage, dirname(entry)), { recursive: true });
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const f of ["LICENSE", "README.md"]) {
  if (existsSync(join(repo, f))) cpSync(join(repo, f), join(stage, f));
}

// A minimal package.json: "type": "module" is load-bearing (the compiled server
// is ESM), and `dependencies` is what the install below resolves.
writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      private: true,
      type: "module",
      dependencies: pkg.dependencies ?? {},
    },
    null,
    2,
  )}\n`,
);

if (run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage).status !== 0) {
  fail("installing runtime dependencies into the stage");
}
if (!existsSync(join(stage, entry))) fail(`entry_point missing from the stage: ${entry}`);
ok(`staged ${entry} plus ${Object.keys(pkg.dependencies ?? {}).length} runtime dependency(ies)`);

if (run("npx", ["mcpb", "validate", join(stage, "manifest.json")], repo).status !== 0) fail("mcpb validate");

const bundle = join(out, `${manifest.name}-${manifest.version}.mcpb`);
rmSync(bundle, { force: true });
if (run("npx", ["mcpb", "pack", stage, bundle], repo).status !== 0) fail("mcpb pack");
if (!existsSync(bundle)) fail(`mcpb pack reported success but wrote no file at ${bundle}`);

console.log(`PASS — ${bundle}`);
