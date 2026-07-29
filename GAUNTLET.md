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

⚠️ **§1 is transcribed from the README, not elicited from the operator.** Treat
the clauses above as inferred until he ratifies or rewrites them.

## §2 Channel map

**A test suite is one channel; it is never the artifact's channel.**

| Artifact | Real channel | Pass condition | Rung? |
|---|---|---|---|
| server process | an MCP client spawns it and speaks JSON-RPC over **stdio** | initialize handshake · tools/list returns the documented set · a real lookup round-trips | ✅ `npm run smoke` drives the real stdio transport; `test/` uses the in-memory transport (29 tests) |
| upstream API contract | live HUD USER API | endpoints answer; token absence is reported, not crashed | ✅ `npm run smoke` (skips loudly without `HUD_API_TOKEN`) |
| public repo | a stranger clones and runs `npm test` | suite green, typecheck clean, README matches served tools | ✅ `npm test` + `npm run typecheck` — ⚠️ **on his machine only; there is no CI** |
| **npm package** | **a stranger runs `npx @haksanlulz/mcp-fairrent` having never cloned** | **bin resolves · server boots · handshake answers** | 🔴 **NO RUNG, AND CURRENTLY IMPOSSIBLE — see §6 escape 2026-07-29** |
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

## §4 Ladder

| Class | Rungs |
|---|---|
| docs-only | none |
| code-touch (`server.ts` / `index.ts` / `test/`) | `npm test` + `npm run typecheck` + §3 scans · **this is a public commit** |
| behavior-change (tool names, schemas, output shape) | + `npm run smoke` with a live token + README tool table + §5 specs |
| artifact-affecting (`package.json`, deps, shebang) | + `npm pack` and install the tarball into a clean directory + drive the installed binary over stdio |
| release (tag / npm publish) | + the full §2 channel map, including the npm rung that does not yet exist |

**Hard gate:** a skipped rung makes the done-report say **BLOCKED**, not done.
`prepublishOnly` (`npm run typecheck && npm test`) enforces the code half of this
mechanically; it does **not** cover the npm channel itself.

## §5 Acceptance specs

*(Operator-owned. None authored yet — this section is deliberately empty rather
than seeded with my guesses. The §1 clauses above are the natural first three.)*

## §6 Escape log

**2026-07-29 · The npm package cannot work, and the install line I recommended was wrong.**
Adding `bin` + `files` + a scoped name and then actually exercising the channel —
`npm pack`, install the tarball into a clean project, spawn the installed binary and
speak MCP to it — showed the binary dies on launch. `index.ts` carries
`#!/usr/bin/env -S npx tsx`, and npm's generated shim cannot honour that: it resolves
`npx-cli.js` inside the *consumer's* `node_modules/npm/`, which does not exist.
Isolated to packaging, not code — the installed source runs correctly when `tsx` is
invoked directly, and the repo's own smoke still passes.
**Fix requires an operator §1 ruling**, because the README states "no build step" as a
design choice: a published bin must be plain JS with `#!/usr/bin/env node`, which means
adding a compile step. `bin` was removed rather than left in a state that looks
publishable and is not.
**New rung** (§4 artifact-affecting): pack, install cold, drive the installed binary
over stdio. **This is the founding-incident shape** — 29 green tests, a passing smoke,
and an artifact that could not start.

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

1. **npm channel** — no rung, and blocked on the §1 build-step ruling above.
2. **No CI on any of the four.** The "stranger clones and runs `npm test`" channel is
   verified on one machine. `label-assay` and `GUDBUS` both have GitHub Actions; these
   do not. A workflow running `npm ci && npm run typecheck && npm test` on 18/20/22 is
   the cheapest real coverage gain here.
3. **README-as-artifact** — it is what LobeHub and Glama render, and nothing checks the
   documented install still works.
4. **vitest version drift** — fairrent 2.1.9, wagewatch 4.1.10. One suite is a major
   version behind its siblings for no recorded reason.
5. **§5 is empty** — no operator-authored acceptance specs anywhere in the set.
