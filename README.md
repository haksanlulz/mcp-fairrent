# mcp-fairrent

MCP server for HUD housing data. Fair Market Rents by bedroom count (per area or a whole state at once), Section 8 income limits by household size, the LIHTC/MTSP income bands tax-credit buildings use, computed affordability verdicts, and the USPS ZIP-to-jurisdiction crosswalk in both directions (ZIP to county/tract/metro/district, and any of those back to its ZIPs). Built on the [MCP TypeScript SDK](https://modelcontextprotocol.io).

For anyone answering "is this rent affordable here, and who qualifies for help?": tenant organizers, legal-aid intake, housing counselors, relocation planners, and agents that need real HUD numbers.

## Tools

| Tool | What it does |
|------|--------------|
| `fmr_lookup` | Fair Market Rent for an area, by bedroom count (efficiency through 4BR). |
| `income_limits` | The 30% / 50% / 80% AMI income thresholds for an area; pass a household size for the one line that applies. The 50% line is the usual Section 8 voucher cutoff. |
| `affordability_check` | The computed verdict: how far a rent sits above or below FMR for a bedroom size (dollars and percent), and which income bands (30/50/80% AMI) a household qualifies under — arithmetic done server-side, with the underlying numbers and table year for citation. |
| `zip_crosswalk` | Map a ZIP to the county, tract, CBSA, CBSA division, congressional district, or county subdivision it sits in, with city/state and all four of HUD's address shares so you pick the right one. |
| `list_counties` | Counties in a state with their FIPS entity ids, to look up by county name. In New England, one row per town, with the town name and a combined area label. |
| `list_metro_areas` | HUD metro areas (CBSAs) with their codes. |
| `mtsp_income_limits` | The LIHTC (tax-credit building) income bands at 20-80% AMI plus the HERA special bands (`/mtspil/data`) — a different table from the Section 8 limits, governing a different housing stock. |
| `state_fmr_overview` | Every county's and metro's FMRs for a whole state in one call (`/fmr/statedata`), for comparing areas without one lookup per county. Also the way to get a working entity id in New England. |
| `geo_to_zips` | The reverse crosswalk: every ZIP inside a county, tract, metro, CBSA division, congressional district, or county subdivision, with residential-address shares and city/state. |

## Install

Nothing to clone. Point your MCP client at it and npm fetches it on first run:

```json
{
  "mcpServers": {
    "fairrent": {
      "command": "npx",
      "args": ["-y", "@haksanlulz/mcp-fairrent"],
      "env": { "HUD_API_TOKEN": "your-hud-token" }
    }
  }
}
```

<details>
<summary>From source (contributors)</summary>

```bash
git clone https://github.com/haksanlulz/mcp-fairrent
cd mcp-fairrent
npm install
npm run build     # emits dist/; the published bin is dist/index.js
```

`npm start` runs the TypeScript directly via [`tsx`](https://github.com/privatenumber/tsx) without building.
</details>

<details>
<summary>As an MCP Bundle (.mcpb)</summary>

For hosts that install MCP Bundles: the bundle declares the HUD token as a required, sensitive setting, so the host collects it in its own UI instead of you editing a JSON `env` block.

```bash
npm run build:mcpb   # writes build/mcp-fairrent-<version>.mcpb
```

Open that file in the host. No bundle is attached to a release yet — build it from source.
</details>

## Token

Every tool needs a free HUD USER API token. One-screen signup at [huduser.gov](https://www.huduser.gov/portal/dataset/fmr-api.html) → set `HUD_API_TOKEN`. The tools tell you so if it's missing.

`HUD_CONTACT` (optional) sets the contact string in the User-Agent sent to HUD; defaults to this repo's URL. Nothing loads a `.env` file — set these in the shell or the MCP client's `env` block (`.env.example` lists them all).

## Environment

| Variable | Default | What it does |
|---|---|---|
| `HUD_API_TOKEN` | — | Required by every tool. Free HUD USER token. |
| `HUD_CONTACT` | this repo's URL | Contact string in the User-Agent sent to HUD. |
| `HUD_HTTP_ATTEMPTS` | `3` | Attempts per HUD request, 1-10. Only 429, 5xx and transport errors are retried. |
| `HUD_RETRY_BACKOFF_MS` | `500,2000` | Wait before each retry, comma-separated. Past the end of the list the last value repeats. |
| `HUD_CACHE_TTL_MS` | `86400000` (24h) | Response-cache lifetime. `0` turns the cache off. |
| `HUD_CACHE_MAX` | `300` | Most responses kept before the oldest is dropped. |

The numeric knobs take a whole number; `HUD_RETRY_BACKOFF_MS` takes a comma-separated list of them. A value that is not one, or that falls outside the stated range, is ignored: the default applies and one line goes to stderr saying so. One bad entry rejects the whole backoff list rather than half of it.

## The flow

An address is usually a ZIP, but `fmr_lookup` and `income_limits` key on a 10-digit county entity id, so bridge the two:

1. `zip_crosswalk` with the ZIP, `to: county` → the county's 5-digit FIPS (ZIP `10451` → geoid `36005`, city `BRONX`, `res_ratio` 1).
2. `list_counties` for that state → the county's 10-digit entity id (Bronx County → `3600599999`).
3. `fmr_lookup` and `income_limits` with that entity id → the bedroom rents and the voucher line.

Worked example: *a Bronx landlord wants $2,600 for a 2-bedroom. Is that above Fair Market Rent, and would a family of three earning $48k qualify for a voucher here?* That's `affordability_check` in one call — the entity id with `rent: 2600, bedrooms: 2, income: 48000, household_size: 3` — and the answer comes back computed. This is the sentence a housing counselor writes down, quoted from the two `verdict` strings as returned:

> Rent $2,600 is $371 (12.5%) below the 2027 Fair Market Rent of $2,971 for a two-bedroom in Bronx County, NY. A 3-person household with annual income $48,000 in Bronx County, NY is very low income (at or below 50% of area median) under the 2026 HUD income limits — generally income-eligible for a Section 8 voucher.

Under those sit the numbers each one came from: the 30% line at $45,850 (does not qualify), the 50% line at $76,350 (qualifies — the usual voucher cutoff), the 80% line at $122,150 (qualifies). The model cites; the server does the arithmetic.

**Two table years in one paragraph, deliberately.** HUD publishes the two tables on separate cycles, and as of 2026-09-14 the FMR table answers 2027 while the income-limit table answers 2026. A combined call therefore carries `table_years: { fmr, income, mismatch }` at the top level, and each verdict names the year of the table that produced it — which is the safe way to quote a figure that goes stale annually, because the year travels with the sentence. Asking for one year across both is refused by HUD rather than quietly downgraded: `affordability_check` says the income tables publish later and names a call that answers.

**New England is the exception, and step 2 is where it bites.** HUD's FMR areas in CT, MA, ME, NH, RI and VT are towns, not counties, so `list_counties` returns one row per town — 169 for Connecticut, 29 of them labelled "Hartford County" — and `town_name` is the only thing telling them apart. Connecticut has gone further: it replaced counties with planning regions and HUD's crosswalk followed, so ZIP `06511` maps to geoid `09170` while `list_counties` for CT still returns legacy `090xx` ids, and none of its 169 rows carries the `09170` prefix. The two do not meet — `0917099999`, the FIPS + `99999` construction, is a 404 on both tables, and `0900952070`, the id `list_counties` gives for New Haven town, is a 404 on the FMR table (the income-limit table resolves it, so a combined call fails on one half only). `list_counties` says so in its own payload for CT. **For a New England state, use `state_fmr_overview` and take the town's `code`**: New Haven town is `0917052070`, which both the FMR and income-limit tables answer on. (Checked live, 2026-09-14.)

## Entity ids

`fmr_lookup` and `income_limits` take a 10-digit county FIPS (e.g. `3600599999`, which is county FIPS `36005` + `99999`) or a metro CBSA code. `zip_crosswalk` and `list_counties` turn a ZIP into one.

## Example

`zip_crosswalk` with `zip: "10451"`, `to: "county"`:

```json
{
  "zip": "10451",
  "to": "county",
  "note": "res_ratio is the share of the ZIP's residential addresses in each geography; the highest-share county is usually the right entityid. bus_ratio, oth_ratio and tot_ratio are the same share for business, other and all addresses.",
  "matches": [
    { "geoid": "36005", "city": "BRONX", "state": "NY", "res_ratio": 1, "bus_ratio": 1, "oth_ratio": 1, "tot_ratio": 1 }
  ],
  "eligibility_scope": "HUD program tables, reproduced as published. Rent figures are Fair Market Rents, not a housing authority's payment standard; income figures are program eligibility lines, not a determination or an award. Confirm with the administering agency before relying on a number for a real household."
}
```

All four of HUD's ratios come through — residential, business, other, and the total — so `tot_ratio` can be reconciled against the parts it is made of. They are rounded to four decimal places. A ZIP with no crosswalk rows (retired, or PO-box-only) answers with an empty `matches` and a note saying so — it is an answer, not an error.

`36005` is Bronx County; `list_counties` with `state: "NY"` gives its entity id `3600599999`, which `fmr_lookup` and `income_limits` take.

## Limitations

- Numbers are HUD's published FMR and income-limit year tables, not live market rents.
- The two tables publish on different cycles, so a combined `affordability_check` can answer from two different years. It reports both in `table_years` and each verdict names its own; a single `year` that only one table has is refused by HUD, not approximated.
- In New England a HUD area is a town. `list_counties` returns one row per town, and in Connecticut the FMR table answers on the planning-region ids in `state_fmr_overview` rather than on the legacy county ids `list_counties` returns (see The flow).
- HUD's tables bound the inputs: bedrooms 0-4 (FMR tables stop at four bedrooms), household size 1-8 (income-limit tables stop at eight; `affordability_check`'s error gives HUD's convention for larger households).
- `affordability_check` compares a single FMR row. Areas whose FMR data comes back multi-row (small-area/ZIP-level, or multi-year) are refused — pass a county entityid, or use `fmr_lookup` to see every row.
- FMR is not the voucher ceiling: housing authorities set payment standards at 90-110% of FMR (24 CFR 982.503). The rent verdict carries this note.
- Every response carries an `eligibility_scope` note: these are program lines, not personal determinations, and an answer is exactly as current as its table year.

## Develop

```bash
npm test          # vitest over an in-memory transport, fetch mocked (no network, no token)
npm run smoke     # one live call per tool (needs HUD_API_TOKEN; skips without)
npm run typecheck
npm run build       # emit dist/ (what actually ships)
npm run verify:pack # pack, install into a clean dir, drive the installed binary over stdio
npm run build:mcpb  # stage + pack the .mcpb bundle into build/
npm run verify:mcpb # unpack that bundle and launch it the way a host does
```

## Testing

Two tiers, already split by script. `npm test` is the offline tier: vitest, in-memory MCP transport, `fetch` mocked, no token. `npm run smoke` is the live tier: one real HUD call per tool, needs `HUD_API_TOKEN`, exits 0 with a skip line without it. CI runs only the offline tier.

Counts, measured 2026-09-14:

```bash
find . -name '*.ts' -not -path './node_modules/*' -not -path './dist/*' -not -path './build/*' -not -path './test/*' -not -name smoke.ts | xargs wc -l   # app: 958 lines (index.ts + server.ts; smoke.ts is another 65)
find ./test -name '*.test.ts' | xargs wc -l                                                                                                                # tests: 1321 lines, 2 files
npm test                                                                                                                                                   # 65 tests, 65 passed
```

`build/` is excluded because `npm run build:mcpb` stages a copy of the server there.

Layers. `test/server.test.ts` drives every tool end to end through the SDK client: input validation (bounds, required pairs, non-positive numbers) rejected before any HUD request; response shaping against fixtures copied from HUD's documented samples; the transport layer (retry on 429 and 5xx, no retry on 404, response cache keyed on path plus params, failures not cached). `test/no-http-stack.test.ts` pins that the source imports only the stdio transport, never an HTTP one, and that `package.json` declares exactly one runtime dependency.

Mutation probe, 2026-09-11: widened the `affordability_check` bedrooms bound in `server.ts` from `> 4` to `> 5`. One test went red: `affordability_check > enforces the table bounds: bedrooms 0-4, household_size 1-8`. 47 others stayed green. Source restored, `git diff --quiet -- server.ts` clean.

Probed again 2026-09-14, once per change landed that day: reverting the metro-status comparison, the statedata name chain, the `FMR Percentile` field, the `?? r.geoid` ZIP fallback, `town_name` on a county row, the town-first area label, the `table_years` block, the income-year error, and the validated env knobs each turned their own test red and nothing else. The retry tests were re-probed after the backoff ladder was flattened for speed — making a 404 retryable, and a 429 not, still fails them.

Call-count assertions (`toHaveBeenCalledTimes`, `not.toHaveBeenCalled`) were audited the same day: 12 sites, 12 kept, 0 pruned. Each one pins a contract (which endpoint a call hit, validation firing before the network, retry counts, cache hits), not that a function ran. Policy: assert behavior and payloads, never bare invocation.

## AI assistance

This project was built with AI assistance (Claude). Correctness rests on the checks, not the generation: the vitest suite drives every tool over the MCP in-memory transport against fixtures that mirror HUD's documented response samples — including this README's worked example — and `npm run smoke` makes one live call per tool against the real HUD API. I reviewed the code and am accountable for what it does.

## License

MIT © Abishai James. Data is public U.S. government data from the HUD USER API; this project is unofficial and not affiliated with HUD.
