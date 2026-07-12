# mcp-fairrent

MCP server for HUD housing data. Looks up Fair Market Rents by bedroom count, Section 8 income limits by household size, and the USPS ZIP-to-jurisdiction crosswalk that maps a ZIP to its county. Built on the [MCP TypeScript SDK](https://modelcontextprotocol.io).

For anyone answering "is this rent affordable here, and who qualifies for help?": tenant organizers, legal-aid intake, housing counselors, relocation planners, and agents that need real HUD numbers instead of a guess.

## Tools

| Tool | What it does |
|------|--------------|
| `fmr_lookup` | Fair Market Rent for an area, by bedroom count (efficiency through 4BR). |
| `income_limits` | The 30% / 50% / 80% AMI income thresholds for an area; pass a household size for the one line that applies. The 50% line is the Section 8 voucher cutoff. |
| `zip_crosswalk` | Map a ZIP to the county, tract, CBSA, or congressional district it sits in, with the residential-address share so you pick the right one. |
| `list_counties` | Counties in a state with their FIPS entity ids, to look up by county name. |
| `list_metro_areas` | HUD metro areas (CBSAs) with their codes. |

## Install

```bash
git clone https://github.com/haksanlulz/mcp-fairrent
cd mcp-fairrent
npm install
```

Runs directly with [`tsx`](https://github.com/privatenumber/tsx); no build step.

## Token

Every tool needs a free HUD USER API token. One-screen signup at [huduser.gov](https://www.huduser.gov/portal/dataset/fmr-api.html) → set `HUD_API_TOKEN`. The tools tell you so if it's missing.

## Use it from an MCP client

```json
{
  "mcpServers": {
    "fairrent": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-fairrent/index.ts"],
      "env": { "HUD_API_TOKEN": "your-hud-token" }
    }
  }
}
```

## The flow

An address is usually a ZIP, but `fmr_lookup` and `income_limits` key on a 10-digit county entity id, so bridge the two:

1. `zip_crosswalk` with the ZIP, `to: county` → the county's 5-digit FIPS (e.g. ZIP 10451 → `36005`).
2. `list_counties` for that state → the county's 10-digit entity id (`36005` → `3600599999`).
3. `fmr_lookup` and `income_limits` with that entity id → the bedroom rents and the voucher line.

Worked example: *a Bronx landlord wants $2,600 for a 2-bedroom. Is that above Fair Market Rent, and would a family of three earning $48k qualify for a voucher here?*

## Entity ids

`fmr_lookup` and `income_limits` take a 10-digit county FIPS (e.g. `3600599999`, which is county FIPS `36005` + `99999`) or a metro CBSA code. `zip_crosswalk` and `list_counties` turn a ZIP into one.

## Example

`zip_crosswalk` with `zip: "10451"`, `to: "county"`:

```json
{
  "zip": "10451",
  "to": "county",
  "matches": [
    { "geoid": "36005", "res_ratio": "1.0", "bus_ratio": "1.0", "tot_ratio": "1.0" }
  ]
}
```

`36005` is Bronx County; `list_counties` with `state: "NY"` gives its entity id `3600599999`, which `fmr_lookup` and `income_limits` take.

## Develop

```bash
npm test          # vitest over an in-memory transport, fetch mocked (no network, no token)
npm run smoke     # one live call per tool (needs HUD_API_TOKEN; skips without)
npm run typecheck
```

## License

MIT © Abishai James. Data is public U.S. government data from the HUD USER API; this project is unofficial and not affiliated with HUD.
