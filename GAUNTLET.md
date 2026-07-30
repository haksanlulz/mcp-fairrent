# GAUNTLET — mcp-fairrent

Constraint state for this server (SSoT). Created by `/gauntlet convert` 2026-07-29.
Operator owns §1 and §5; Claude maintains §2–§4 and §6, transcribing operator rulings only.

This file is the pilot for all four civic servers (`mcp-fairrent`, `mcp-nychousing`,
`mcp-wagewatch`, `mcp-courtwatch`) — they are near-identical in shape and every
finding below was audited across all four. Sibling precedent:
`mcp-scryfall/GAUNTLET.md`.

## §1 Oracle — done-definition

- **It is**: a stdio MCP server over the HUD USER API. Six tools — `fmr_lookup`,
  `income_limits`, `affordability_check`, `zip_crosswalk`, `list_counties`,
  `list_metro_areas`. It exists so that "is this rent affordable here, and who
  qualifies for help?" is answered from HUD's published tables with a citable
  table year, rather than from a model's recall.
- **DONE means**: (a) an MCP client sees all six tools and a real lookup
  round-trips over stdio; (b) `affordability_check` returns the arithmetic AND
  the underlying numbers and table year, so the caller can cite rather than
  trust; (c) every upstream request is serialized, spaced, timed out, and
  identifies itself.
- **Non-goals**: live market rents (HUD tables only), voucher-ceiling advice
  (FMR is not the payment standard — 24 CFR 982.503), storing tenant data.

- **MUST NEVER** (operator, 2026-07-29): *"It says someone qualifies when they
  don't."* A false positive on an AMI band costs a real person a filing fee, a
  document run, and a rejection. Any ambiguity at a threshold resolves against
  the applicant qualifying. Locked by SPEC `qualification-never-overstates`.

⚠️ The three bullets above the MUST NEVER line are still transcribed from the
README rather than elicited; the MUST NEVER clause is operator-authored.

## §2 Channel map

**A test suite is one channel; it is never the artifact's channel.**

| Artifact | Real channel | Pass condition | Rung? |
|---|---|---|---|
| server process | an MCP client spawns it and speaks JSON-RPC over **stdio** | initialize handshake · tools/list returns the documented set · a real lookup round-trips | ✅ **`npm run verify:pack` spawns the installed binary and speaks real stdio** (added 2026-07-29). ⚠️ `npm run smoke` and `test/` are BOTH `InMemoryTransport` — an earlier version of this table claimed smoke drove real stdio; it does not, and that claim was wrong when written. |
| upstream API contract | live HUD USER API | endpoints answer; token absence is reported, not crashed | ✅ `npm run smoke` (skips loudly without `HUD_API_TOKEN`) |
| public repo | a stranger clones and runs `npm test` | suite green, typecheck clean, build emits | ✅ **GitHub Actions, Node 18/20/22** (added 2026-07-29): `npm ci` → typecheck → build → test, plus a separate `package` job running `verify:pack` |
| **npm package** | a stranger runs `npx @haksanlulz/mcp-fairrent` having never cloned | bin shim resolves · server boots · handshake answers · tools/list is well-formed | ✅ **`npm run verify:pack`** — builds, packs, installs the tarball into a throwaway project, launches **through the bin shim**, speaks MCP. Mutation-probed against the real historical defect: restoring the `npx tsx` shebang turns it red. Wired into CI. |
| registry listing (LobeHub, Glama) | a stranger reads the README there and follows it cold | documented install produces a working server | 🔴 **NO RUNG** — the README is the consumed artifact on those sites and nothing checks it stays executable |

## §3 Invariants — scans

| Invariant | Scan | Status |
|---|---|---|
| Concurrent calls cannot breach the throttle | vitest: *"serializes concurrent requests through the throttle queue"* | ✅ present |
| Spacing is start-to-start, not gap+latency | vitest: *"spaces request STARTS by the throttle gap"* | ✅ present |
| One hung request cannot wedge later calls | `AbortSignal.timeout(15_000)` on every fetch | ✅ present (assertion via the header test) |
| Every request identifies itself to HUD | vitest asserts `User-Agent` matches `^mcp-fairrent/\d` | ✅ **added 2026-07-29, mutation-probed red** |
| Token never enters the query string | vitest asserts header-only auth | ✅ present |
| Published tarball ships no tests/tooling | `files` whitelist + `npm pack --dry-run` | ✅ **added 2026-07-29** — 6 files, 9.8 kB |
| No band overstates qualification (SPEC `qualification-never-overstates`) | vitest: *"one dollar over any line disqualifies that band"* | ✅ **added 2026-07-29**, mutation-probed red via `limit + 1` |

## §4 Ladder

| Class | Rungs |
|---|---|
| docs-only | none |
| code-touch (`server.ts` / `index.ts` / `test/`) | `npm test` + `npm run typecheck` + §3 scans · **this is a public commit** |
| behavior-change (tool names, schemas, output shape) | + `npm run smoke` with a live token + README tool table + §5 specs |
| artifact-affecting (`package.json`, deps, shebang, tsconfig) | + **`npm run verify:pack`** |
| release (tag / npm publish) | + the full §2 channel map + `npm run smoke` with a live token + §5 specs |

**Hard gate:** a skipped rung makes the done-report say **BLOCKED**, not done.
`prepublishOnly` (`build && typecheck && test`) enforces the code half mechanically.
The npm channel itself is covered by `verify:pack`, which CI runs on every push.

## §5 Acceptance specs

### SPEC qualification-never-overstates
```
Given a household whose income sits one dollar above an AMI threshold
When affordability_check runs
Then that band reports qualifies:false
```
The direction matters and is the whole spec. A false negative sends someone to
check a second source; a false positive sends them to file. Every line carries
its own over-by-a-dollar guard, not just the topmost one — the pre-existing
suite tested exact-dollar behaviour at all three lines but only tested
one-dollar-over at 80%, so 30% and 50% were unguarded in the dangerous
direction.

Check: `test/server.test.ts` (tagged `spec: qualification-never-overstates`),
alongside the pre-existing *"qualification is at-or-below at every threshold
boundary"*, which owns the at-the-line half.
**Red-capable:** mutating `income <= limit` to `income <= limit + 1` fails it
(probed 2026-07-29, restored). That mutation IS the operator's stated failure.

*Slots 2 and 3 are open and operator-owned.*

## §6 Escape log

**2026-07-29 · The CI rung added that same day could never have fired on `mcp-fairrent`.**
The workflow triggers on `push: branches: [main]`; this repo's branch is `master`, and so
is its GitHub default (remote `master`, last pushed 2026-07-18). Every sibling is on `main`,
so the file was written once and copied across four repos without checking that the trigger
matched the branch it landed on. A dead rung reads exactly like a passing one — nothing
fails, no run appears, and the channel-map row still says ✅. Caught incidentally, from a
`git commit` printing `[master ...]` while the siblings printed `[main ...]`.
**Fixed**: `branches: [main, master]` in all four. **Rule 14 family** — a rung must be
verified through the orchestrator's real channel, and "the workflow file exists" is not
that verification. Still unverified until first push: whether GitHub Actions is enabled on
these repos at all.

**2026-07-29 · The npm package cannot work, and the install line I recommended was wrong.**
Adding `bin` + `files` + a scoped name and then actually exercising the channel —
`npm pack`, install the tarball into a clean project, spawn the installed binary and
speak MCP to it — showed the binary dies on launch. `index.ts` carries
`#!/usr/bin/env -S npx tsx`, and npm's generated shim cannot honour that: it resolves
`npx-cli.js` inside the *consumer's* `node_modules/npm/`, which does not exist.
Isolated to packaging, not code — the installed source runs correctly when `tsx` is
invoked directly, and the repo's own smoke still passes.
**RESOLVED same day by operator ruling** ("bring it up to our best"): a compile step went
in. `tsc` already had `outDir`/`rootDir`/`nodenext` configured and every relative import
already carried a `.js` extension, so the build cost was the shebang and the wiring —
`#!/usr/bin/env node`, `bin` → `dist/index.js`, `files: ["dist"]`, `prepublishOnly`.
**⚑ And the first version of the new rung was toothless.** It spawned `node dist/index.js`
directly, which bypasses the shebang — so it passed against the broken package. Caught by
mutation-probing the rung itself; it now launches through the **bin shim**, and restoring
the `npx tsx` shebang turns it red. **This is the founding-incident shape twice over** —
29 green tests plus a passing smoke over an artifact that could not start, and then a
rung that could not see it.

**2026-07-29 · `mcp-wagewatch` shipped with no User-Agent at all; 21 green tests never noticed.**
It called a free federal API as an anonymous Node client while all three siblings
identified themselves. Fixed, and the missing assertion added to all four —
mutation-probed in each. **New rung** (§3): every server asserts its own UA.

**2026-07-29 · Four of my own probes returned confident wrong answers in one session.**
`npm pack --dry-run` writes no file, so an install test ran against a tarball that never
existed and reported "no bin linked". A UA mutation probe grepped stdout for
`"User-Agent"`, which also appears in a *passing* run because it is in the test name.
A test-count grep missed fairrent entirely because it runs vitest 2.1.9 with ANSI codes
while the siblings run 4.1.10. A rate-limiter read called fairrent's throttle naive when
it is correctly serialized. **Standing rule for this repo: a probe that cannot be shown
to return a negative is not evidence** (workspace Audit Discipline Rules 22/23).

## Known gaps, ranked by blast radius

1. **README-as-artifact.** It is what LobeHub and Glama render, and it still documents the
   old clone-and-point-tsx-at-it install. Nothing checks the documented path executes, and
   the published package now supports a shorter one. **Highest-value remaining item.**
2. **§5 holds one spec of a planned three** — the operator's stated MUST-NEVER for this
   server is authored, implemented and linked (2026-07-29). Slots 2 and 3 are open. §1's
   descriptive bullets are still transcribed from the README rather than elicited; only the
   MUST NEVER clause is in his words.
3. **The package's true Node floor is UNMEASURED.** The `package` job runs
   `npm ci` first, which installs the full dev tree (vitest 4 → vite 8, requiring
   Node `^20.19 || >=22.12`), so it cannot run on 18 and dies before reaching the
   tarball. A real consumer never runs `npm ci` here — they `npx` the published
   package, which ships only `dist/` plus the MCP SDK. Proving 18 needs a
   two-stage job: build and pack on 20, upload the artifact, install and speak
   MCP to it on 18. Not built. **No `engines` field is declared, deliberately** —
   an unmeasured floor asserted as fact is worse than saying nothing.
4. **vitest version drift** — fairrent 2.1.9, the siblings 4.1.10. No longer
   cosmetic: it was the entire reason fairrent was the only repo whose first real
   CI run passed on Node 18 (2026-07-30).
4. **`smoke` is in-memory, not stdio.** `verify:pack` now covers the real-stdio channel, so
   smoke's remaining job is the live upstream contract. Its name oversells it.
5. **Nothing is published yet.** The package is verified publishable; `npm publish` is an
   operator action.
