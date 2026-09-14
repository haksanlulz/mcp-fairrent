#!/usr/bin/env node
/**
 * CHANNEL RUNG — the .mcpb bundle, exercised the way a host installs it.
 *
 * Sibling of pack-probe.mjs, which does this for the npm tarball. A test suite
 * is one channel; it is never the artifact's channel. This one unzips the built
 * bundle into a throwaway directory, reads manifest.server.mcp_config, spawns
 * exactly that command with ${__dirname} and ${user_config.*} substituted the
 * way a host substitutes them, and speaks MCP JSON-RPC to it over stdio.
 *
 * With HUD_API_TOKEN set it also makes one real tool call, which is the only
 * way to show that a token injected through user_config actually reaches the
 * server. Without one it says so and stops short of that step.
 *
 * Run: npm run verify:mcpb   (after npm run build:mcpb)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Teardown never decides the verdict, but it has to actually run, and it did
// not on either path. Measured 2026-09-14: process.exit() inside fail()
// abandons the stack rather than unwinding it, so the `finally` at the bottom
// never ran on a FAIL (`try { process.exit(1) } finally { console.log("x") }`
// prints nothing); and on a PASS, child.kill() under shell:true killed the
// shell, not the node grandchild, which still held the directory as its cwd --
// so rmSync threw EBUSY into a bare catch. One unpacked 12MB bundle leaked per
// run, on both paths, 22 of them before anyone counted.
let cleanup = () => {};
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  cleanup();
  process.exit(1);
};
const ok = (m) => console.log(`  ok  ${m}`);

// --- find the bundle -------------------------------------------------------
const provided = process.env.MCPB_PROBE_BUNDLE;
let bundlePath;
if (provided) {
  if (!existsSync(provided)) fail(`MCPB_PROBE_BUNDLE does not exist: ${provided}`);
  bundlePath = resolve(provided);
} else {
  const buildDir = join(repo, "build");
  const found = existsSync(buildDir) ? readdirSync(buildDir).filter((f) => f.endsWith(".mcpb")) : [];
  if (found.length !== 1) fail(`expected exactly one .mcpb in build/, found ${found.length}. Run npm run build:mcpb`);
  bundlePath = join(buildDir, found[0]);
}
console.log(`mcpb-probe: ${bundlePath}`);

// --- unzip, without adding a dependency to do it ---------------------------
// A .mcpb is a zip. Reading one is ~40 lines of central-directory walk plus
// zlib, which ships with node; `unzip` does not exist on every machine this
// runs on and Expand-Archive exists on only one of them.
function unzip(buf, dest) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail("no end-of-central-directory record: that is not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  // Rather than mis-read a zip64 archive as a truncated one, say so.
  if (count === 0xffff || off === 0xffffffff) fail("zip64 bundle; this probe reads plain zip only");
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) fail(`bad central-directory entry at ${off}`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.includes("..")) fail(`refusing a bundle entry that escapes the directory: ${name}`);
    const target = join(dest, name);
    if (name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (buf.readUInt32LE(localOff) !== 0x04034b50) fail(`bad local header for ${name}`);
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else fail(`unsupported compression method ${method} for ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return count;
}

const dir = mkdtempSync(join(tmpdir(), "mcpbprobe-"));
let child;
cleanup = () => {
  // shell:true means child.pid is the shell's, not the server's. Kill the tree,
  // or the node grandchild is still sitting in `dir` when rmSync runs.
  if (child?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGKILL");
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (e) {
    // Still not the artifact's failure, but say so rather than swallow it.
    console.error(`  warn  could not remove ${dir}: ${e.code}`);
  }
};
try {
  const entries = unzip(readFileSync(bundlePath), dir);
  ok(`unpacked ${entries} entries`);

  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) fail("bundle has no manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const entry = manifest.server?.entry_point;
  if (!entry) fail("manifest declares no server.entry_point");
  if (!existsSync(join(dir, entry))) fail(`server.entry_point is not in the bundle: ${entry}`);
  ok(`entry_point present: ${entry}`);

  const cfg = manifest.server?.mcp_config;
  if (!cfg?.command) fail("manifest declares no server.mcp_config.command");

  // Substitute the way a host does: ${__dirname} is the install directory, and
  // ${user_config.KEY} is what the user typed into the host's own UI.
  const token = process.env.HUD_API_TOKEN;
  const userConfig = { api_token: token ?? "" };
  const sub = (s) =>
    String(s)
      .split("${__dirname}")
      .join(dir)
      .replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/g, (_, k) => String(userConfig[k] ?? ""));

  const required = Object.entries(manifest.user_config ?? {}).filter(([, v]) => v.required);
  if (!required.some(([k]) => k === "api_token")) fail("api_token is not declared required in user_config");
  if (!manifest.user_config.api_token.sensitive) fail("api_token is not declared sensitive in user_config");
  ok("api_token is required and sensitive");

  const args = (cfg.args ?? []).map(sub);

  // A host hands the server the manifest's env block, not the operator's shell.
  // Copying process.env meant a variable the manifest FORGOT was supplied by
  // inheritance -- so the live round trip below would have answered with the
  // token from this shell even if mcp_config.env injected nothing, which is one
  // of the two things this probe exists to catch. Start from the handful of OS
  // variables a child needs to run at all, then add the manifest's own.
  const OS_ESSENTIAL = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "COMSPEC",
    "TEMP", "TMP", "TMPDIR", "HOME", "HOMEDRIVE", "HOMEPATH", "USERPROFILE",
    "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMDATA", "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE", "OS", "LANG", "LC_ALL",
  ];
  const env = {};
  for (const k of OS_ESSENTIAL) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = sub(v);
  if (!("HUD_API_TOKEN" in (cfg.env ?? {}))) fail("mcp_config.env does not inject HUD_API_TOKEN");

  // Quote every arg. With shell:true the shell re-splits the command line, and
  // the install directory here is under the user profile -- measured on a
  // tmpdir containing a space, the unquoted form exits 1 with "Cannot find
  // module 'C:\\Users\\abish\\AppData\\Local\\Temp\\probe'" and the quoted form
  // exits 0. That failure reads as a FAIL of the bundle and is a claim about
  // the probe. pack-probe.mjs quotes its bin shim for the same reason.
  child = spawn(cfg.command, args.map((a) => `"${a}"`), { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], shell: true });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reply = (id) =>
    out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((m) => m && m.id === id);

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcpb-probe", version: "1.0.0" } },
  });
  await wait(1500);
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await wait(2000);

  const init = reply(1);
  if (!init?.result) fail(`no initialize response. stderr: ${err.slice(0, 500)}`);
  ok(`initialize -> ${init.result.serverInfo?.name}@${init.result.serverInfo?.version}`);

  const tools = reply(2)?.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) fail(`tools/list returned nothing. stderr: ${err.slice(0, 500)}`);
  const served = tools.map((t) => t.name).sort();
  const declared = (manifest.tools ?? []).map((t) => t.name).sort();
  if (served.length !== 9) fail(`expected the nine documented tools, got ${served.length}: ${served.join(", ")}`);
  if (JSON.stringify(served) !== JSON.stringify(declared)) {
    fail(`manifest tools and served tools disagree.\n  manifest: ${declared.join(", ")}\n  served:   ${served.join(", ")}`);
  }
  ok(`tools/list -> ${served.length}, matching the manifest`);

  if (token) {
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_metro_areas", arguments: {} } });
    await wait(12000);
    const called = reply(3);
    const body = called?.result?.content?.[0]?.text ?? "";
    if (!called?.result) fail(`tools/call returned no result. stderr: ${err.slice(0, 500)}`);
    if (called.result.isError) fail(`tools/call failed with the injected token: ${body.slice(0, 300)}`);
    if (!body.includes("cbsa_code")) fail(`tools/call answered without metro rows: ${body.slice(0, 300)}`);
    ok("a live HUD call answered, so the user_config token reached the server");
  } else {
    console.log("  skip  no HUD_API_TOKEN: the injected-token round trip was not exercised");
  }

  child.kill();
  await new Promise((r) => {
    child.once("exit", r);
    setTimeout(r, 3000);
  });
  console.log("PASS — the bundle unpacks, launches from its manifest, and serves its tools.");
} finally {
  cleanup();
}
// The spawned child can keep the event loop alive after kill(); exit explicitly
// so a passing probe does not hang the rung it is wired into.
process.exit(0);
