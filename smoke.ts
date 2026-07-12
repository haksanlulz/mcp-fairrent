#!/usr/bin/env -S npx tsx
// Live smoke: one real call per tool against the HUD USER API.
// Needs HUD_API_TOKEN (free, one-screen signup at huduser.gov). Skips if unset.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

if (!process.env.HUD_API_TOKEN) {
  console.log("skip: HUD_API_TOKEN not set (get one free at huduser.gov). No live smoke.");
  process.exit(0);
}

const server = createServer();
const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);

let failed = 0;
async function check(name: string, args: Record<string, unknown>, ok: (b: any) => boolean) {
  try {
    const res: any = await client.callTool({ name, arguments: args });
    const body = JSON.parse(res.content[0].text);
    if (ok(body)) console.log(`ok   ${name}`);
    else { failed++; console.error(`FAIL ${name}: unexpected shape\n${JSON.stringify(body).slice(0, 300)}`); }
  } catch (e: any) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
}

// Bronx: ZIP 10451 -> county GEOID 36005 -> FMR + income limits.
await check("zip_crosswalk", { zip: "10451", to: "county" }, (b) => Array.isArray(b.matches) && b.matches.length > 0);
await check("list_counties", { state: "NY" }, (b) => Array.isArray(b.counties) && b.counties.length > 0);
await check("list_metro_areas", {}, (b) => Array.isArray(b.metros) && b.metros.length > 0);

const bronxFips = await (async () => {
  try {
    const res: any = await client.callTool({ name: "list_counties", arguments: { state: "NY" } });
    const rows = JSON.parse(res.content[0].text).counties as any[];
    return rows.find((c) => /bronx/i.test(c.county_name))?.fips_code;
  } catch { return undefined; }
})();

if (bronxFips) {
  await check("fmr_lookup", { entityid: bronxFips }, (b) => !!b.fair_market_rents);
  await check("income_limits", { entityid: bronxFips, household_size: 3 }, (b) => b.very_low_50pct !== undefined);
  // the README worked example, answered server-side
  await check(
    "affordability_check",
    { entityid: bronxFips, rent: 2600, bedrooms: 2, income: 48000, household_size: 3 },
    (b) => typeof b.rent_check?.delta === "number" && !!b.rent_check?.verdict && !!b.income_check?.verdict,
  );
} else {
  failed++;
  console.error("FAIL fmr_lookup/income_limits/affordability_check: could not resolve a Bronx FIPS from list_counties");
}

console.log(failed === 0 ? "smoke: all passed" : `smoke: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
