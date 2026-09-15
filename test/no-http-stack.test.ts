import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * This server speaks MCP over stdio and never starts a web server. That is not a
 * style preference -- it is the reason a whole class of Dependabot alerts against
 * this repo is not exploitable here.
 *
 * @modelcontextprotocol/sdk depends on hono, @hono/node-server and express to
 * support its HTTP transports. Those ship in the dependency tree, so advisories
 * against them are reported against this repo -- hono alone drew 3-9 per month
 * through 2026. None reach this server, because nothing here imports a transport
 * that uses them.
 *
 * ⚠️ WHAT THIS TEST DOES AND DOES NOT PROVE.
 *
 * It asserts a property of OUR source: we import the stdio transport and nothing
 * else. That is the thing under our control and the thing that would change if
 * someone added an HTTP surface, so it is the thing worth pinning.
 *
 * It does NOT prove the SDK never loads hono internally. An earlier version of
 * this test tried to prove exactly that by hooking Module._resolveFilename, and
 * it was a FALSE GREEN: that hook is the CommonJS resolver, these are ESM
 * modules, and a planted `await import("hono")` sailed straight through it. The
 * lesson is kept here because the failure mode -- a guard that cannot go red --
 * is worse than no guard.
 *
 * ⚠️ If this fails, do NOT relax it. It means an HTTP transport entered the
 * executed path and every hono/express advisory against this repo just became
 * live.
 */
const TRANSPORT_IMPORT = /@modelcontextprotocol\/sdk\/server\/(\w+)\.js/g;
const ALLOWED_TRANSPORTS = new Set(["stdio", "index"]);

describe("dependency surface", () => {
  it("imports only the stdio transport, never an HTTP one", () => {
    const offenders: string[] = [];
    for (const f of ["index.ts", "server.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const m of src.matchAll(TRANSPORT_IMPORT)) {
        if (!ALLOWED_TRANSPORTS.has(m[1])) offenders.push(`${f}: ${m[0]}`);
      }
      // The HTTP transports are also reachable by these names.
      for (const bad of ["streamableHttp", "sse", "express", "hono"]) {
        if (new RegExp(`from ["'][^"']*${bad}`, "i").test(src)) {
          offenders.push(`${f}: imports ${bad}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares exactly one runtime dependency", () => {
    // The tarball ships dist/ plus whatever `dependencies` resolves to, so
    // keeping that list at one entry is what bounds the shipped surface. A
    // second runtime dep should be a deliberate decision, not a surprise.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@modelcontextprotocol/sdk"]);
  });
});

/**
 * stdout is the JSON-RPC channel. A single non-JSON line interleaved into it
 * breaks framing for the client, and the server is then dead to a user who did
 * nothing worse than typo a knob in their config.
 *
 * knobWarn (server.ts) is this server's only console write and correctly goes
 * to stderr, but until this test nothing could see it move: the offline suite
 * runs over InMemoryTransport, which has no stdout at all, and both channel
 * probes launch with valid knobs so the warn line never fires in either. Same
 * shape as the resolver hook this file already records — a guard that cannot go
 * red is worse than no guard, so here is one that can.
 *
 * This is the source half. The behavioural half — that knobWarn itself picks
 * console.error — is in server.test.ts under "environment knobs", and the real
 * channel is pack-probe.mjs, which now launches the installed binary with a
 * deliberately malformed knob.
 */
const STDOUT_WRITES = /(?:console\.(?:log|info|warn|debug)|process\.stdout\.write)\s*\(/g;

describe("stdio channel discipline", () => {
  it("writes diagnostics to stderr only, never to stdout", () => {
    const offenders: string[] = [];
    for (const f of ["index.ts", "server.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const m of src.matchAll(STDOUT_WRITES)) offenders.push(`${f}: ${m[0]}`);
    }
    // If this fails, the write belongs on console.error. There is no stdout
    // budget to spend: the transport owns that file descriptor.
    expect(offenders).toEqual([]);
  });
});
