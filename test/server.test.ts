import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, REQUEST_GAP_MS, clearHudCache, hudConfig } from "../server";

async function connect(): Promise<Client> {
  const server = createServer();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// The response cache lives for the process; without this a value cached by one
// test is served to the next and the suite becomes order-dependent.
//
// The backoff ladder is flattened for the same reason the fetch is mocked:
// nothing here is waiting on HUD. At the shipped 500/2000ms ladder the four
// tests that exercise a retry slept through 17.6s of the suite's 18.1s. What
// those tests assert -- how many attempts, and which statuses are retryable --
// is untouched by the wall clock, and the ladder itself is asserted separately
// under "environment knobs".
beforeEach(() => {
  clearHudCache();
  vi.stubEnv("HUD_RETRY_BACKOFF_MS", "0,0");
});

function mockFetch(payload: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }),
  );
}
// Route by URL fragment, for tools that hit more than one HUD endpoint.
function mockFetchRoutes(routes: Array<[fragment: string, payload: unknown]>) {
  return vi.fn(async (url: any) => {
    const u = String(url);
    const hit = routes.find(([fragment]) => u.includes(fragment));
    return new Response(JSON.stringify(hit ? hit[1] : { error: `no mock route for ${u}` }), {
      status: hit ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  });
}
function bodyOf(res: any) {
  return JSON.parse(res.content[0].text);
}

// The tools that take an entityid. Both the schema description and the thrown
// error have to route a ZIP through the crosswalk rather than offer it as an
// entityid, so both halves are checked against this one list.
const ENTITYID_TOOLS = ["fmr_lookup", "income_limits", "affordability_check", "mtsp_income_limits"] as const;

// Response shapes below mirror HUD's documented API examples (fmr/il/usps/list);
// field names are quoted from HUD's own response samples.
//
// metro_status is "1.0" because that is what HUD serves — captured live from
// /fmr/data/3600599999 on 2026-09-14. This fixture said "1" until then, a shape
// the API does not produce, which is why 48 green tests could not see that
// `metro_status === "1"` is false for every metro FMR area in the country.
// The sibling flag smallarea_status really is served as "1", no decimal -- but
// not by this entity, which carries no smallarea_status at all. The "1" spelling
// was captured from /fmr/data/METRO15380M15380 (Buffalo-Cheektowaga) the same
// day, which serves metro_status "1.0" beside smallarea_status "1".
const FMR_PAYLOAD = {
  data: {
    county_name: "Bronx County",
    counties_msa: "New York-White Plains, NY-NJ HUD Metro FMR Area",
    town_name: "",
    metro_status: "1.0",
    metro_name: "New York-White Plains, NY-NJ HUD Metro FMR Area",
    smallarea_status: "0",
    basicdata: {
      Efficiency: "1875.0",
      "One-Bedroom": "1945.0",
      "Two-Bedroom": "2213.0",
      "Three-Bedroom": "2818.0",
      "Four-Bedroom": "3015.0",
      year: "2026",
    },
  },
};
const IL_PAYLOAD = {
  data: {
    county_name: "Bronx County",
    metro_name: "New York, NY HUD Metro FMR Area",
    year: "2026",
    median_income: "97800",
    very_low: { il50_p1: "42650", il50_p2: "48750", il50_p3: "54850", il50_p4: "60900", il50_p5: "65800", il50_p6: "70650", il50_p7: "75550", il50_p8: "80400" },
    extremely_low: { il30_p1: "25600", il30_p2: "29250", il30_p3: "32900", il30_p4: "36550", il30_p5: "39500", il30_p6: "42400", il30_p7: "45350", il30_p8: "48250" },
    low: { il80_p1: "68250", il80_p2: "78000", il80_p3: "87750", il80_p4: "97450", il80_p5: "105250", il80_p6: "113050", il80_p7: "120850", il80_p8: "128650" },
  },
};
const CROSSWALK_PAYLOAD = {
  data: {
    year: "2026",
    quarter: "1",
    input: "10451",
    crosswalk_type: "zip-county",
    results: [
      { zip: "10451", geoid: "36005", res_ratio: "1.0", bus_ratio: "1.0", oth_ratio: "1.0", tot_ratio: "1.0" },
    ],
  },
};

describe("mcp-fairrent server", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes all nine tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "affordability_check",
      "fmr_lookup",
      "geo_to_zips",
      "income_limits",
      "list_counties",
      "list_metro_areas",
      "mtsp_income_limits",
      "state_fmr_overview",
      "zip_crosswalk",
    ]);
  });

  it("fmr_lookup hits the entity path with a bearer token and shapes bedroom rents", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const fetchMock = mockFetch(FMR_PAYLOAD);
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain("/hudapi/public/fmr/data/3600599999");
    expect(call[1].headers.Authorization).toBe("Bearer test-token");
    // HUD USER is a free public service: identify ourselves on every call. A
    // missing UA is invisible to every other assertion here, which is how the
    // sibling wagewatch server shipped without one until 2026-07-29.
    expect(call[1].headers["User-Agent"]).toMatch(/^mcp-fairrent\/\d/);
    const body = bodyOf(res);
    expect(body.area).toBe("Bronx County");
    // HUD serves metro_status "1.0", so a string compare against "1" reports
    // false for an area that IS a metro FMR area. Compare numerically.
    expect(body.is_metro).toBe(true);
    expect(body.fair_market_rents.two_br).toBe("2213.0");
    expect(body.fair_market_rents.four_br).toBe("3015.0");
  });

  it("fmr_lookup normalizes an array basicdata (metro breakdown)", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      mockFetch({
        data: {
          metro_name: "Some Metro",
          metro_status: "1.0",
          basicdata: [
            { "Two-Bedroom": "1000", year: "2025" },
            { "Two-Bedroom": "1100", year: "2026" },
          ],
        },
      }),
    );
    const client = await connect();
    const res = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "METRO123" } });
    const body = bodyOf(res);
    expect(Array.isArray(body.fair_market_rents)).toBe(true);
    expect(body.fair_market_rents[1].two_br).toBe("1100");
  });

  it("income_limits with household_size returns the single applicable threshold", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const fetchMock = mockFetch(IL_PAYLOAD);
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "income_limits",
      arguments: { entityid: "3600599999", household_size: 3 },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/il/data/3600599999");
    const body = bodyOf(res);
    expect(body.median_income).toBe("97800");
    expect(body.very_low_50pct).toBe("54850"); // il50_p3
    expect(body.extremely_low_30pct).toBe("32900"); // il30_p3
    expect(body.household_size).toBe(3);
  });

  it("income_limits without a size returns all eight thresholds per band", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch(IL_PAYLOAD));
    const client = await connect();
    const res = await client.callTool({ name: "income_limits", arguments: { entityid: "3600599999" } });
    const body = bodyOf(res);
    expect(body.very_low_50pct).toHaveLength(8);
    expect(body.very_low_50pct[0]).toBe("42650"); // il50_p1
  });

  it("income_limits rejects an out-of-range household size", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const client = await connect();
    {
      const res: any = await client.callTool({ name: "income_limits", arguments: { entityid: "x", household_size: 9 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/1-8/);
    }
  });

  it("zip_crosswalk maps 'county' to type=2 and shapes the ratios", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const fetchMock = mockFetch(CROSSWALK_PAYLOAD);
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({ name: "zip_crosswalk", arguments: { zip: "10451", to: "county" } });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/usps?");
    expect(url).toContain("type=2");
    expect(url).toContain("query=10451");
    const body = bodyOf(res);
    expect(body.matches[0].geoid).toBe("36005");
    expect(body.matches[0].res_ratio).toBe(1); // ratios now numeric, 4dp
    // All four of HUD's ratios: without oth_ratio, tot_ratio cannot be
    // reconciled against the parts it is made of.
    expect(body.matches[0].oth_ratio).toBe(1);
  });

  it("zip_crosswalk rejects a non-5-digit ZIP and an unknown target", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const client = await connect();
    {
      const res: any = await client.callTool({ name: "zip_crosswalk", arguments: { zip: "1045" } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/5-digit/);
    }
    {
      const res: any = await client.callTool({ name: "zip_crosswalk", arguments: { zip: "10451", to: "planet" } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/unknown target/);
    }
  });

  it("list_counties shapes county rows", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      mockFetch({ data: [{ county_name: "Bronx County", fips_code: "3600599999", state_code: "NY" }] }),
    );
    const client = await connect();
    const res = await client.callTool({ name: "list_counties", arguments: { state: "ny" } });
    const body = bodyOf(res);
    expect(body.counties[0].fips_code).toBe("3600599999");
  });

  // New England is the one region where a HUD "county" row is really a town,
  // and the only region where dropping town_name changes what a caller sees --
  // which is why no fixture covered it until now. Rows below are a live capture
  // of /fmr/listCounties/CT, 2026-09-14 (169 rows, 8 distinct county_name
  // values, 29 of them "Hartford County").
  const CT_COUNTIES_PAYLOAD = {
    data: [
      { state_code: "CT", fips_code: "0900302060", county_name: "Hartford County", town_name: "Avon town", category: "County" },
      { state_code: "CT", fips_code: "0900304300", county_name: "Hartford County", town_name: "Berlin town", category: "County" },
    ],
  };

  it("list_counties keeps the town that distinguishes a New England row", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch(CT_COUNTIES_PAYLOAD));
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "list_counties", arguments: { state: "CT" } }));
    const [avon, berlin] = body.counties;
    // Same county label, different entity ids: without town_name the caller is
    // choosing blind between 29 rows and can pick the wrong town's FMR.
    expect(avon.county_name).toBe(berlin.county_name);
    expect(avon.fips_code).not.toBe(berlin.fips_code);
    expect(avon.town_name).toBe("Avon town");
    expect(berlin.town_name).toBe("Berlin town");
    expect(avon.area).toBe("Avon town, Hartford County");
    expect(avon.category).toBe("County");
  });

  it("warns in the payload that Connecticut's ids are the ones the FMR table refuses", async () => {
    // The warning existed in the tool description and the README. A model that
    // already has the tool loaded reads the RESULT, and this is the one tool
    // whose own ids are dead in part of its output: live 2026-09-14,
    // /fmr/data/0900952070 (the New Haven town id this list returns) is a 404
    // while /fmr/data/0917052070 answers 200.
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch(CT_COUNTIES_PAYLOAD));
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "list_counties", arguments: { state: "CT" } }));
    expect(String(body.note)).toMatch(/one per town/);
    expect(String(body.note)).toMatch(/404/);
    expect(String(body.note)).toMatch(/state_fmr_overview/);
  });

  it("carries the town warning in the other five New England states, without the CT id warning", async () => {
    // Massachusetts town ids from this same endpoint DO answer the FMR table
    // (/fmr/data/2502300170 -> 200, live 2026-09-14), so the 404 half is
    // Connecticut's renumbering and must not be claimed for the region.
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch({
      data: [{ state_code: "MA", fips_code: "2502300170", county_name: "Plymouth County", town_name: "Abington town", category: "County" }],
    }));
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "list_counties", arguments: { state: "MA" } }));
    expect(String(body.note)).toMatch(/one per town/);
    expect(String(body.note)).not.toMatch(/404/);
  });

  it("adds no New England note outside those six states", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch({ data: [{ county_name: "Bronx County", fips_code: "3600599999", state_code: "NY" }] }));
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "list_counties", arguments: { state: "NY" } }));
    expect(body.note).toBeUndefined();
  });

  it("area labels lead with the town where HUD gives one", async () => {
    // /il/data/0900901220 live, 2026-09-14: HUD answers with the planning
    // region AND the town, and only the town says which of the region's rows
    // this is.
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch({
      data: {
        county_name: "Naugatuck Valley Planning Region, CT",
        town_name: "Ansonia town",
        metro_name: "Waterbury-Shelton, CT",
        metro_status: "1.0",
        year: "2026",
        median_income: 114000,
        very_low: { il50_p3: 56050 },
        extremely_low: { il30_p3: 33650 },
        low: { il80_p3: 89700 },
      },
    }));
    const client = await connect();
    const body = bodyOf(await client.callTool({
      name: "income_limits",
      arguments: { entityid: "0900901220", household_size: 3 },
    }));
    expect(body.area).toBe("Ansonia town, Naugatuck Valley Planning Region, CT");
  });

  it("tools fail with a get-a-token hint when HUD_API_TOKEN is unset", async () => {
    vi.stubEnv("HUD_API_TOKEN", "");
    const client = await connect();
    {
      const res: any = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "NY" } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/huduser\.gov/);
    }
  });

  it("surfaces a HUD error body instead of returning junk", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch({ error: "Unauthenticated" }, 401));
    const client = await connect();
    {
      const res: any = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "NY" } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/Unauthenticated/);
    }
  });

  it("fmr_lookup array rows fall back to the top-level year", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      // real small-area shape: year only at top level, none per array row
      mockFetch({ data: { metro_name: "M", metro_status: "1.0", year: "2026", basicdata: [{ zip_code: "10451", "Two-Bedroom": "2213.0" }] } }),
    );
    const client = await connect();
    const res = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "METRO123" } });
    expect(bodyOf(res).fair_market_rents[0].year).toBe("2026");
  });

  it("list_metro_areas shapes metro rows", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      mockFetch({ data: [{ cbsa_code: "35620", area_name: "New York-Newark-Jersey City, NY-NJ-PA", category: "Metropolitan" }] }),
    );
    const client = await connect();
    const res = await client.callTool({ name: "list_metro_areas", arguments: {} });
    expect(bodyOf(res).metros[0].cbsa_code).toBe("35620");
  });

  it("passes the year param through to the FMR endpoint when given", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const fetchMock = mockFetch(FMR_PAYLOAD);
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999", year: "2025" } });
    expect(String(fetchMock.mock.calls[0][0])).toContain("year=2025");
  });

  it("serializes concurrent requests through the throttle queue", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    let inFlight = 0;
    let maxConcurrent = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify(FMR_PAYLOAD), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const client = await connect();
    await Promise.all([
      client.callTool({ name: "fmr_lookup", arguments: { entityid: "A" } }),
      client.callTool({ name: "fmr_lookup", arguments: { entityid: "B" } }),
      client.callTool({ name: "fmr_lookup", arguments: { entityid: "C" } }),
    ]);
    expect(maxConcurrent).toBe(1);
  });

  it("entityid schema descriptions route ZIPs through the crosswalk, not raw ZIP/state", async () => {
    // an LLM fills args from the SCHEMA, so the entityid property description must
    // match the tool prose: a 10-digit county entityid or a CBSA, derived from a
    // ZIP via zip_crosswalk -> list_counties. It must not advertise ZIP/state as
    // a directly acceptable entityid.
    const client = await connect();
    const { tools } = await client.listTools();
    for (const name of ENTITYID_TOOLS) {
      const tool = tools.find((t) => t.name === name)!;
      const desc = (tool.inputSchema.properties as any).entityid.description as string;
      expect(desc).toContain("zip_crosswalk");
      expect(desc).toContain("99999");
    }
  });

  it("the thrown entityid error says the same thing the schema does", async () => {
    // The schema half of this was fixed; the ERROR half still offered "state
    // code ... or ZIP" and no test covered it. A model that hits the validation
    // error reads it and retries with what it names, and HUD 400s a raw ZIP, a
    // bare county FIPS and a state code alike (live 2026-09-14).
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const fetchMock = mockFetch(FMR_PAYLOAD);
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    for (const name of ENTITYID_TOOLS) {
      const args: Record<string, unknown> = { entityid: "" };
      if (name === "affordability_check") Object.assign(args, { rent: 2600, bedrooms: 2 });
      const res: any = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBe(true);
      const msg = String(res.content[0].text);
      expect(msg, name).toContain("zip_crosswalk");
      expect(msg, name).toContain("99999");
      expect(msg, name).not.toMatch(/state code/i); // HUD 400s /fmr/data/NY
      expect(msg, name).not.toMatch(/or ZIP\)/i); // and /fmr/data/10451
    }
    expect(fetchMock).not.toHaveBeenCalled(); // the error fires before any HUD call
  });

  it("spaces request STARTS by the throttle gap, not gap + response latency", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const FETCH_LATENCY = 100; // simulated response time; strictly less than REQUEST_GAP_MS
    const TIMER_SLOP_MS = 5;   // see the floor assertion below — clock granularity, not slack in the contract
    const starts: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      starts.push(Date.now()); // record when each request actually STARTS
      await new Promise((r) => setTimeout(r, FETCH_LATENCY));
      return new Response(JSON.stringify(FMR_PAYLOAD), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const client = await connect();
    await Promise.all([
      client.callTool({ name: "fmr_lookup", arguments: { entityid: "A" } }),
      client.callTool({ name: "fmr_lookup", arguments: { entityid: "B" } }),
      client.callTool({ name: "fmr_lookup", arguments: { entityid: "C" } }),
    ]);
    expect(starts).toHaveLength(3);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    for (const gap of gaps) {
      // Tolerance, not a weakened assertion. setTimeout may fire a hair early and
      // performance.now() rounds, so a shared CI runner measured 149 for a 150ms
      // gap and turned this red (mcp-fairrent, Node 20, 2026-07-30). What the test
      // actually distinguishes is ~150 from ~150+latency — a 200ms difference —
      // so a couple of milliseconds of slack costs the test nothing.
      expect(gap).toBeGreaterThanOrEqual(REQUEST_GAP_MS - TIMER_SLOP_MS); // the throttle floor holds
      expect(gap).toBeLessThan(REQUEST_GAP_MS + FETCH_LATENCY); // latency is NOT added on top (the old completion-spacing bug)
    }
  });

  // affordability_check: the README's worked example answered server-side.
  // Fixture math against IL_PAYLOAD/FMR_PAYLOAD (household of 3): 30% line 32900,
  // 50% line 54850, 80% line 87750; two-bedroom FMR 2213, year 2026.
  describe("affordability_check", () => {
    const BOTH = () => mockFetchRoutes([
      ["/fmr/data/", FMR_PAYLOAD],
      ["/il/data/", IL_PAYLOAD],
    ]);

    it("answers the README worked example: rent gap and income bands in one call", async () => {
      vi.stubEnv("HUD_API_TOKEN", "test-token");
      const fetchMock = BOTH();
      vi.stubGlobal("fetch", fetchMock);
      const client = await connect();
      const res = await client.callTool({
        name: "affordability_check",
        arguments: { entityid: "3600599999", rent: 2600, bedrooms: 2, income: 48000, household_size: 3 },
      });
      const urls = fetchMock.mock.calls.map((c: any[]) => String(c[0]));
      expect(urls.some((u) => u.includes("/fmr/data/3600599999"))).toBe(true);
      expect(urls.some((u) => u.includes("/il/data/3600599999"))).toBe(true);
      const body = bodyOf(res);
      expect(body.area).toBe("Bronx County");
      // rent side: computed numbers the LLM can cite, plus the verdict prose
      expect(body.rent_check.fmr).toBe(2213);
      expect(body.rent_check.year).toBe("2026"); // which year's table answered
      expect(body.rent_check.delta).toBe(387);
      expect(body.rent_check.delta_pct).toBe(17.5);
      expect(body.rent_check.above_fmr).toBe(true);
      expect(body.rent_check.verdict).toMatch(/\$387/);
      expect(body.rent_check.verdict).toMatch(/17\.5%/);
      expect(body.rent_check.verdict).toMatch(/above the 2026 Fair Market Rent of \$2,213/);
      // income side: one readout per band, boundary-inclusive
      expect(body.income_check.year).toBe("2026");
      expect(body.income_check.categories.extremely_low_30pct).toEqual(
        expect.objectContaining({ limit: 32900, qualifies: false }),
      );
      expect(body.income_check.categories.very_low_50pct).toEqual(
        expect.objectContaining({ limit: 54850, qualifies: true }),
      );
      expect(body.income_check.categories.low_80pct).toEqual(
        expect.objectContaining({ limit: 87750, qualifies: true }),
      );
      expect(body.income_check.categories.extremely_low_30pct.readout).toMatch(/above/);
      expect(body.income_check.categories.very_low_50pct.readout).toMatch(/at or below/);
      expect(body.income_check.verdict).toMatch(/is very low income/);
      expect(body.income_check.verdict).toMatch(/Section 8 voucher/);
    });

    it("reports a below-FMR rent with a negative delta", async () => {
      vi.stubEnv("HUD_API_TOKEN", "test-token");
      vi.stubGlobal("fetch", BOTH());
      const client = await connect();
      const res = await client.callTool({
        name: "affordability_check",
        arguments: { entityid: "3600599999", rent: 1900, bedrooms: 2 },
      });
      const body = bodyOf(res);
      expect(body.rent_check.delta).toBe(-313);
      expect(body.rent_check.delta_pct).toBe(-14.1);
      expect(body.rent_check.above_fmr).toBe(false);
      expect(body.rent_check.verdict).toMatch(/\$313/);
      expect(body.rent_check.verdict).toMatch(/below the 2026 Fair Market Rent/);
    });

    it("says so when the rent is exactly the FMR", async () => {
      vi.stubEnv("HUD_API_TOKEN", "test-token");
      vi.stubGlobal("fetch", BOTH());
      const client = await connect();
      const res = await client.callTool({
        name: "affordability_check",
        arguments: { entityid: "3600599999", rent: 2213, bedrooms: 2 },
      });
      const body = bodyOf(res);
      expect(body.rent_check.delta).toBe(0);
      expect(body.rent_check.above_fmr).toBe(false);
      expect(body.rent_check.verdict).toMatch(/exactly/);
    });

    it("qualification is at-or-below at every threshold boundary", async () => {
      vi.stubEnv("HUD_API_TOKEN", "test-token");
      vi.stubGlobal("fetch", BOTH());
      const client = await connect();
      const at = async (income: number) =>
        bodyOf(await client.callTool({
          name: "affordability_check",
          arguments: { entityid: "3600599999", income, household_size: 3 },
        })).income_check;

      const atThirty = await at(32900); // exactly the 30% line
      expect(atThirty.categories.extremely_low_30pct.qualifies).toBe(true);
      expect(atThirty.verdict).toMatch(/is extremely low income/);

      const atFifty = await at(54850); // exactly the 50% (voucher) line
      expect(atFifty.categories.extremely_low_30pct.qualifies).toBe(false);
      expect(atFifty.categories.very_low_50pct.qualifies).toBe(true);
      expect(atFifty.verdict).toMatch(/is very low income/);

      const atEighty = await at(87750); // exactly the 80% line
      expect(atEighty.categories.very_low_50pct.qualifies).toBe(false);
      expect(atEighty.categories.low_80pct.qualifies).toBe(true);
      expect(atEighty.verdict).toMatch(/is low income/);
      expect(atEighty.verdict).toMatch(/above the usual Section 8 voucher line/);

      const overAll = await at(87751); // one dollar over every line
      expect(overAll.categories.low_80pct.qualifies).toBe(false);
      expect(overAll.verdict).toMatch(/not income-eligible/);
    });

    it("rent-only call returns only rent_check and never hits the income endpoint", async () => {
      vi.stubEnv("HUD_API_TOKEN", "test-token");
      const fetchMock = BOTH();
      vi.stubGlobal("fetch", fetchMock);
      const client = await connect();
      const res = await client.callTool({
        name: "affordability_check",
        arguments: { entityid: "3600599999", rent: 2600, bedrooms: 2 },
      });
      const body = bodyOf(res);
      expect(body.rent_check.above_fmr).toBe(true);
      expect(body.income_check).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain("/fmr/data/");
    });

    it("income-only call returns only income_check and never hits the FMR endpoint", async () => {
      vi.stubEnv("HUD_API_TOKEN", "test-token");
      const fetchMock = BOTH();
      vi.stubGlobal("fetch", fetchMock);
      const client = await connect();
      const res = await client.callTool({
        name: "affordability_check",
        arguments: { entityid: "3600599999", income: 48000, household_size: 3 },
      });
      const body = bodyOf(res);
      expect(body.income_check.verdict).toMatch(/very low income/);
      expect(body.rent_check).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain("/il/data/");
    });

    it("rejects a call with nothing to check or half an input pair", async () => {
      vi.stubEnv("HUD_API_TOKEN", "test-token");
      const fetchMock = BOTH();
      vi.stubGlobal("fetch", fetchMock);
      const client = await connect();
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "3600599999" } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/nothing to check/);
    }
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "3600599999", rent: 2600 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/bedrooms/);
    }
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "3600599999", income: 48000 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/household_size/);
    }
      expect(fetchMock).not.toHaveBeenCalled(); // validation fires before any HUD call
    });

    it("enforces the table bounds: bedrooms 0-4, household_size 1-8", async () => {
      vi.stubEnv("HUD_API_TOKEN", "test-token");
      const fetchMock = BOTH();
      vi.stubGlobal("fetch", fetchMock);
      const client = await connect();
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "x", rent: 2600, bedrooms: 5 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/0-4/);
    }
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "x", rent: 2600, bedrooms: 2.5 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/0-4/);
    }
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "x", income: 48000, household_size: 9 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/1-8/);
    }
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "x", income: 48000, household_size: 0 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/1-8/);
    }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a non-positive rent and a negative income", async () => {
      vi.stubEnv("HUD_API_TOKEN", "test-token");
      const fetchMock = BOTH();
      vi.stubGlobal("fetch", fetchMock);
      const client = await connect();
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "x", rent: 0, bedrooms: 2 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/rent/);
    }
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "x", rent: -100, bedrooms: 2 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/rent/);
    }
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "x", income: -1, household_size: 3 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/income/);
    }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses multi-row FMR data (small-area metros) with a pointer to a county entityid", async () => {
      vi.stubEnv("HUD_API_TOKEN", "test-token");
      vi.stubGlobal(
        "fetch",
        mockFetch({ data: { metro_name: "M", metro_status: "1.0", smallarea_status: "1", year: "2026", basicdata: [{ zip_code: "10451", "Two-Bedroom": "2213.0" }] } }),
      );
      const client = await connect();
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "METRO123", rent: 2600, bedrooms: 2 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/county entityid/);
    }
    });

    it("errors on holes in the tables instead of comparing against NaN", async () => {
      vi.stubEnv("HUD_API_TOKEN", "test-token");
      vi.stubGlobal("fetch", mockFetchRoutes([
        // FMR table missing its four-bedroom line; IL table with empty bands
        ["/fmr/data/", { data: { county_name: "Bronx County", basicdata: { Efficiency: "1875.0", year: "2026" } } }],
        ["/il/data/", { data: { county_name: "Bronx County", year: "2026", very_low: {}, extremely_low: {}, low: {} } }],
      ]));
      const client = await connect();
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "3600599999", rent: 2600, bedrooms: 4 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/four-bedroom/);
    }
      {
      const res: any = await client.callTool({ name: "affordability_check", arguments: { entityid: "3600599999", income: 48000, household_size: 3 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/3-person/);
    }
    });

    it("passes the year param through to both endpoints", async () => {
      vi.stubEnv("HUD_API_TOKEN", "test-token");
      const fetchMock = BOTH();
      vi.stubGlobal("fetch", fetchMock);
      const client = await connect();
      await client.callTool({
        name: "affordability_check",
        arguments: { entityid: "3600599999", rent: 2600, bedrooms: 2, income: 48000, household_size: 3, year: "2025" },
      });
      const urls = fetchMock.mock.calls.map((c: any[]) => String(c[0]));
      expect(urls).toHaveLength(2);
      for (const u of urls) expect(u).toContain("year=2025");
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC qualification-never-overstates — operator-authored 2026-07-29
// ---------------------------------------------------------------------------

describe("SPEC qualification-never-overstates", () => {
  // Same two-route fixture the affordability_check block uses; redeclared here
  // because that one is scoped to its own describe.
  const BOTH = () => mockFetchRoutes([
    ["/fmr/data/", FMR_PAYLOAD],
    ["/il/data/", IL_PAYLOAD],
  ]);

  // spec: qualification-never-overstates
  // Given a household one dollar above an AMI threshold
  // When affordability_check runs
  // Then that band reports qualifies:false — the error that costs someone a
  //      filing fee and a rejection is the FALSE POSITIVE, so every line gets
  //      its over-by-a-dollar guard, not just the topmost one.
  // Operator's stated worst failure for this server:
  //      "it says someone qualifies when they don't."
  it("one dollar over any line disqualifies that band", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", BOTH());
    const client = await connect();
    const at = async (income: number) =>
      bodyOf(await client.callTool({
        name: "affordability_check",
        arguments: { entityid: "3600599999", income, household_size: 3 },
      })).income_check;

    // 30% line is 32900, 50% is 54850, 80% is 87750.
    expect((await at(32901)).categories.extremely_low_30pct.qualifies).toBe(false);
    expect((await at(54851)).categories.very_low_50pct.qualifies).toBe(false);
    expect((await at(87751)).categories.low_80pct.qualifies).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Two tables, two publication clocks
// ---------------------------------------------------------------------------

describe("affordability_check across two table years", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Live captures, 2026-09-14: /fmr/data/3600599999 answers 2027 by default,
  // /il/data/3600599999 answers 2026 and rejects year=2027 outright.
  const FMR_2027 = {
    data: {
      county_name: "Bronx County, NY",
      counties_msa: "",
      town_name: "",
      metro_status: "1.0",
      metro_name: "New York-Newark-Jersey City, NY-NJ",
      basicdata: { Efficiency: 2593, "One-Bedroom": 2729, "Two-Bedroom": 2971, "Three-Bedroom": 3760, "Four-Bedroom": 4121, year: "2027" },
    },
  };
  const IL_2026 = {
    data: {
      county_name: "Bronx County, NY",
      metro_name: "New York-Newark-Jersey City, NY-NJ",
      year: "2026",
      median_income: 104300,
      very_low: { il50_p3: 76350 },
      extremely_low: { il30_p3: 45850 },
      low: { il80_p3: 122150 },
    },
  };

  // Like mockFetchRoutes, but each route carries its own HTTP status, because
  // the case under test is one endpoint answering 200 and the other 400.
  function routedWithStatus(routes: Array<[fragment: string, payload: unknown, status: number]>) {
    return vi.fn(async (url: any) => {
      const u = String(url);
      const hit = routes.find(([fragment]) => u.includes(fragment));
      const [, payload, status] = hit ?? [undefined, { error: `no mock route for ${u}` }, 404];
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    });
  }

  it("names both table years and flags the mismatch", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", routedWithStatus([
      ["/fmr/data/", FMR_2027, 200],
      ["/il/data/", IL_2026, 200],
    ]));
    const client = await connect();
    const body = bodyOf(await client.callTool({
      name: "affordability_check",
      arguments: { entityid: "3600599999", rent: 2600, bedrooms: 2, income: 48000, household_size: 3 },
    }));
    expect(body.table_years.fmr).toBe("2027");
    expect(body.table_years.income).toBe("2026");
    expect(body.table_years.mismatch).toBe(true);
    expect(String(body.table_years.note)).toMatch(/separate cycles/);
    // The two verdicts still name their own years; the block exists so the
    // difference is visible without reading both strings.
    expect(body.rent_check.verdict).toMatch(/2027 Fair Market Rent/);
    expect(body.income_check.verdict).toMatch(/2026 HUD income limits/);
  });

  it("does not flag a mismatch when both tables answer the same year", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", routedWithStatus([
      ["/fmr/data/", { data: { ...FMR_2027.data, basicdata: { ...FMR_2027.data.basicdata, year: "2026" } } }, 200],
      ["/il/data/", IL_2026, 200],
    ]));
    const client = await connect();
    const body = bodyOf(await client.callTool({
      name: "affordability_check",
      arguments: { entityid: "3600599999", rent: 2600, bedrooms: 2, income: 48000, household_size: 3 },
    }));
    expect(body.table_years).toEqual({ fmr: "2026", income: "2026", mismatch: false });
  });

  it("keeps the rent verdict when the income table refuses the year", async () => {
    // The caller saw 2027 on the rent side and asked for it on both. HUD's raw
    // answer names /il/data and a status code; it does not say the income
    // tables lag. Rewriting the message was half the fix -- the Promise.all
    // still rejected, so the rent verdict HUD had answered 200 for was thrown
    // away with it. Keep the half that answered.
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", routedWithStatus([
      ["/fmr/data/", FMR_2027, 200],
      ["/il/data/", { error: "Invalid year" }, 400],
    ]));
    const client = await connect();
    const res: any = await client.callTool({
      name: "affordability_check",
      arguments: { entityid: "3600599999", rent: 2600, bedrooms: 2, income: 48000, household_size: 3, year: "2027" },
    });
    expect(res.isError).toBeFalsy();
    const body = bodyOf(res);
    expect(body.rent_check.verdict).toMatch(/2027 Fair Market Rent/);
    expect(body.table_years.fmr).toBe("2027");
    // The income half is present and says it did not answer. No band is
    // reported, so nothing here can overstate qualification.
    expect(body.income_check.answered).toBe(false);
    expect(body.income_check.categories).toBeUndefined();
    expect(String(body.income_check.verdict)).toMatch(/income-limit tables publish on a later cycle/);
    expect(String(body.income_check.verdict)).toMatch(/Re-run affordability_check with no year/);
    expect(body.table_years.income).toBeUndefined();
    expect(body.table_years.mismatch).toBeUndefined();
  });

  it("still fails outright when the refused year is the only half asked for", async () => {
    // Income-only: there is no answered half to keep, so the refusal is the
    // whole answer and belongs in the error rather than in a payload with
    // nothing in it.
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", routedWithStatus([["/il/data/", { error: "Invalid year" }, 400]]));
    const client = await connect();
    const res: any = await client.callTool({
      name: "affordability_check",
      arguments: { entityid: "3600599999", income: 48000, household_size: 3, year: "2027" },
    });
    expect(res.isError).toBe(true);
    const msg = String(res.content[0].text);
    expect(msg).toMatch(/income-limit tables publish on a later cycle/);
    // And it does not blame the publication lag ALONE. Live 2026-09-14,
    // /il/data answers the same 400 "Invalid year" for 2027 (ahead of the
    // income table) and for 2010 (behind both tables, /fmr/data refuses it
    // too), so a past year reaching this branch was being told the income
    // table simply had not published yet.
    expect(msg).toMatch(/behind the tables HUD still serves/);
    // No rent half asked for, so there is no table_years block to point at.
    expect(msg).not.toMatch(/table_years/);
  });

  it("does not rewrite an 'Invalid year' that arrives when no year was asked for", async () => {
    // The branch the ternary in the handler already anticipated. Rewriting it
    // there told the caller to "Re-run affordability_check with no year" --
    // which is exactly what they did -- and, with a rent half, offered
    // "call fmr_lookup with year." naming no year and no action.
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", routedWithStatus([
      ["/fmr/data/", FMR_2027, 200],
      ["/il/data/", { error: "Invalid year" }, 400],
    ]));
    const client = await connect();
    const res: any = await client.callTool({
      name: "affordability_check",
      arguments: { entityid: "3600599999", income: 48000, household_size: 3 },
    });
    expect(res.isError).toBe(true);
    const msg = String(res.content[0].text);
    expect(msg).toMatch(/Invalid year/);
    expect(msg).not.toMatch(/later cycle/);
    expect(msg).not.toMatch(/Re-run affordability_check with no year/);
  });

  it("still surfaces an ordinary IL 400 unchanged", async () => {
    // A bad entityid also 400s. That one is the caller's mistake and must not
    // be relabelled as a publication-cycle problem.
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", routedWithStatus([
      ["/il/data/", { error: "Missing or invalid value in the query parameter(s)" }, 400],
    ]));
    const client = await connect();
    const res: any = await client.callTool({
      name: "affordability_check",
      arguments: { entityid: "36005", income: 48000, household_size: 3 },
    });
    expect(res.isError).toBe(true);
    expect(String(res.content[0].text)).toMatch(/Missing or invalid value/);
    expect(String(res.content[0].text)).not.toMatch(/later cycle/);
  });
});

describe("fairrent 1.1.0", () => {
  it("a retired ZIP (HUD 404 no-data) answers with the empty-note shape, not an error", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch([{ error: "No data found using the value 10048 for type 2" }], 404));
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "zip_crosswalk", arguments: { zip: "10048" } }));
    expect(body.matches).toEqual([]);
    expect(String(body.note)).toContain("PO-box");
  });

  it("crosswalk ratios round to four decimal places", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch({ data: { results: [{ zip: "10451", city: "BRONX", state: "NY", res_ratio: "0.044077448175895165", bus_ratio: "1", tot_ratio: "0.5" }] } }));
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "geo_to_zips", arguments: { from: "county", geoid: "36005" } }));
    expect(body.zips[0].res_ratio).toBe(0.0441);
    expect(body.zips[0].bus_ratio).toBe(1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

// ---------------------------------------------------------------------------
// 1.1.0: mtsp_income_limits, state_fmr_overview, geo_to_zips, scope notes,
// error-shape parity with the sibling servers
// ---------------------------------------------------------------------------

const MTSP_PAYLOAD = {
  data: {
    county_name: "Bronx County",
    metro_name: "New York, NY HUD Metro FMR Area",
    year: "2026",
    median_income: "97800",
    "50percent": { il50_p1: "42650", il50_p2: "48750", il50_p3: "54850", il50_p4: "60900", il50_p5: "65800", il50_p6: "70650", il50_p7: "75550", il50_p8: "80400" },
    "60percent": { il60_p1: "51180", il60_p2: "58500", il60_p3: "65820", il60_p4: "73080", il60_p5: "78960", il60_p6: "84780", il60_p7: "90660", il60_p8: "96480" },
    hera_special_60percent: { hera_special_il60_p1: "52000", hera_special_il60_p2: "59400", hera_special_il60_p3: "66840", hera_special_il60_p4: "74220", hera_special_il60_p5: "80160", hera_special_il60_p6: "86100", hera_special_il60_p7: "92040", hera_special_il60_p8: "97980" },
  },
};

// Re-derived from a live capture of /fmr/statedata/NY, 2026-09-14. The previous
// fixture was inverted against the API on both row types: its metro row carried
// `name` and no metro_name (HUD serves the exact opposite, which is why every
// metro row came back with name:undefined), and neither row carried HUD's
// "FMR Percentile". Rents arrive as numbers here, not strings.
const STATEDATA_PAYLOAD = {
  data: {
    year: "2027",
    metroareas: [
      { metro_name: "Buffalo-Cheektowaga, NY MSA", code: "METRO15380M15380", Efficiency: 1178, "One-Bedroom": 1203, "Two-Bedroom": 1423, "Three-Bedroom": 1732, "Four-Bedroom": 1977, "FMR Percentile": 40, statename: "New York", statecode: "NY", smallarea_status: "1" },
    ],
    counties: [
      { town_name: null, county_name: "Albany County", metro_name: "Albany-Schenectady-Troy, NY MSA", fips_code: "3600199999", Efficiency: 1238, "One-Bedroom": 1425, "Two-Bedroom": 1711, "Three-Bedroom": 2039, "Four-Bedroom": 2249, "FMR Percentile": 40, statename: "New York", statecode: "NY", smallarea_status: "0" },
    ],
  },
};

// Re-derived from a live capture of /usps?type=7&query=36005, 2026-09-14. The
// county->ZIP rows key the ZIP as `geoid` and carry the source county as
// `county`; there is no `zip` field at all, so the `r.zip ?? r.geoid` fallback
// in server.ts is the branch that always runs against real HUD -- and the old
// fixture, which carried `zip`, was the only branch any test exercised.
const REVERSE_CROSSWALK_PAYLOAD = {
  data: {
    year: "2026",
    quarter: "2",
    input: "36005",
    crosswalk_type: "county-zip",
    results: [
      { county: "36005", geoid: "10451", city: "BRONX", state: "NY", res_ratio: 0.044245220742676915, bus_ratio: 0.04981041020337815, oth_ratio: 0.030411632193323778, tot_ratio: 0.04348672911096552 },
      { county: "36005", geoid: "10452", city: "BRONX", state: "NY", res_ratio: 0.05569243387054831, bus_ratio: 0.045777318166149605, oth_ratio: 0.037907024370264185, tot_ratio: 0.053986578607220635 },
    ],
  },
};

describe("mtsp_income_limits", () => {
  it("hits /mtspil/data and shapes the LIHTC bands including HERA special", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const fetchMock = mockFetch(MTSP_PAYLOAD);
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "mtsp_income_limits", arguments: { entityid: "3600599999", household_size: 2 } }));
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/mtspil/data/3600599999");
    expect(body.pct_50).toBe("48750");
    expect(body.pct_60).toBe("58500");
    expect(body.hera_special_60).toBe("59400");
    expect(body.eligibility_scope).toContain("not a determination");
  });

  it("rejects a bad household size before any network call", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const fetchMock = mockFetch(MTSP_PAYLOAD);
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res: any = await client.callTool({ name: "mtsp_income_limits", arguments: { entityid: "x", household_size: 12 } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("1-8");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("state_fmr_overview", () => {
  it("returns every metro and county for a state in one call", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const fetchMock = mockFetch(STATEDATA_PAYLOAD);
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "state_fmr_overview", arguments: { state: "ny" } }));
    expect(String(fetchMock.mock.calls[0][0])).toContain("/fmr/statedata/NY");
    expect(body.metro_areas[0].small_area_fmrs).toBe(true);
    expect(body.counties[0].name).toBe("Albany County");
    expect(body.counties[0].two_br).toBe(1711);
    expect(body.eligibility_scope).toBeDefined();
  });

  it("names the metro rows too, from HUD's metro_name", async () => {
    // A metro row carries metro_name and none of county_name / name / town_name,
    // so a shaper without metro_name in the chain returns name:undefined for
    // every metro in the state -- half the result of a tool whose whole job is
    // metros AND counties.
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch(STATEDATA_PAYLOAD));
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "state_fmr_overview", arguments: { state: "ny" } }));
    expect(body.metro_areas[0].name).toBe("Buffalo-Cheektowaga, NY MSA");
    expect(body.metro_areas[0].code).toBe("METRO15380M15380");
  });

  it("carries HUD's FMR percentile on both row types", async () => {
    // 40th vs 50th percentile is a real program distinction (a 50th-percentile
    // area's FMRs are set higher on purpose), and the shaper dropped it.
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch(STATEDATA_PAYLOAD));
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "state_fmr_overview", arguments: { state: "ny" } }));
    expect(body.metro_areas[0].fmr_percentile).toBe(40);
    expect(body.counties[0].fmr_percentile).toBe(40);
  });
});

describe("geo_to_zips", () => {
  it("uses the reverse crosswalk type code and carries city/state per ZIP", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const fetchMock = mockFetch(REVERSE_CROSSWALK_PAYLOAD);
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "geo_to_zips", arguments: { from: "county", geoid: "36005" } }));
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("type=7"); // county -> zip, per HUD's 12-type table
    expect(url).toContain("query=36005");
    expect(body.zip_count).toBe(2);
    expect(body.zips[0].city).toBe("BRONX");
    expect(String(body.note)).toContain("res_ratio");
    // The ZIP comes from `geoid`: HUD's county->ZIP rows have no `zip` field.
    // Delete the `?? r.geoid` fallback in server.ts and this goes red.
    expect(body.zips[0].zip).toBe("10451");
    expect(body.zips[1].zip).toBe("10452");
    expect(body.zips[0].res_ratio).toBe(0.0442);
    expect(body.zips[0].oth_ratio).toBe(0.0304); // all four of HUD's ratios
  });

  it("rejects an unknown source geography with the valid list", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch(REVERSE_CROSSWALK_PAYLOAD));
    const client = await connect();
    const res: any = await client.callTool({ name: "geo_to_zips", arguments: { from: "planet", geoid: "1" } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("tract, county");
  });
});

describe("sibling-standard hardening", () => {
  it("a handler error returns isError content, not a protocol error", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch({ error: "quota exceeded" }, 429));
    const client = await connect();
    const res: any = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Error:");
    expect(res.content[0].text).toContain("quota exceeded");
  });

  it("zip_crosswalk carries city/state and an empty result explains itself", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch({ data: { results: [] } }));
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "zip_crosswalk", arguments: { zip: "99999" } }));
    expect(body.matches).toEqual([]);
    expect(String(body.note)).toContain("PO-box");
    expect(body.eligibility_scope).toBeDefined();
  });

  it("every eligibility verdict rides the scope note", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch(IL_PAYLOAD));
    const client = await connect();
    const body = bodyOf(await client.callTool({ name: "income_limits", arguments: { entityid: "3600599999" } }));
    expect(body.eligibility_scope).toContain("eligibility lines");
  });
});

});

describe("transient-failure retry", () => {
  // HUD's endpoint is shared and public, so a 429 or 5xx means "come back", not
  // "no". These pin what must and must not be retried -- retry-everything would
  // spend the 60/min budget re-asking a question already answered.
  it("retries a 5xx and succeeds on the next attempt", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    let n = 0;
    const flaky = vi.fn(async () => {
      n++;
      return n === 1
        ? new Response(JSON.stringify({ error: "upstream" }), { status: 503, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ data: { basicdata: [{ zip_code: "10451", Efficiency: 1, "One-Bedroom": 2 }] } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", flaky);
    const client = await connect();
    await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 404", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const miss = mockFetch({ error: "not found" }, 404);
    vi.stubGlobal("fetch", miss);
    const client = await connect();
    const res: any = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    expect(res.isError).toBe(true);
    expect(miss).toHaveBeenCalledTimes(1);
  });

  it("retries a 429, since that one means slow down", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const busy = mockFetch({ error: "rate limited" }, 429);
    vi.stubGlobal("fetch", busy);
    const client = await connect();
    const res: any = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    expect(res.isError).toBe(true);
    expect(busy).toHaveBeenCalledTimes(3);
  });
});

describe("environment knobs", () => {
  // Every one of these was verified against the running server before the
  // validation went in: a typo in any of the three disabled the thing it
  // configures, and only HUD_HTTP_ATTEMPTS was loud about it -- with the wrong
  // message ("Error: undefined").
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("falls back to the documented default for a value that is not a whole number", () => {
    vi.stubEnv("HUD_HTTP_ATTEMPTS", "oops");
    vi.stubEnv("HUD_RETRY_BACKOFF_MS", "oops");
    vi.stubEnv("HUD_CACHE_TTL_MS", "oops");
    vi.stubEnv("HUD_CACHE_MAX", "oops");
    expect(hudConfig()).toEqual({
      attempts: 3,
      retryBackoffMs: [500, 2000],
      cacheTtlMs: 24 * 60 * 60 * 1000,
      cacheMax: 300,
    });
  });

  it("rejects a backoff ladder with one bad rung, rather than half-parsing it", () => {
    vi.stubEnv("HUD_RETRY_BACKOFF_MS", "100,nope,400");
    expect(hudConfig().retryBackoffMs).toEqual([500, 2000]);
    vi.stubEnv("HUD_RETRY_BACKOFF_MS", "100, 400 ,900");
    expect(hudConfig().retryBackoffMs).toEqual([100, 400, 900]);
  });

  it("rejects out-of-range values that would disable the knob", () => {
    vi.stubEnv("HUD_HTTP_ATTEMPTS", "0"); // a zero-attempt loop never runs
    vi.stubEnv("HUD_CACHE_MAX", "0"); // a zero bound evicts nothing
    expect(hudConfig().attempts).toBe(3);
    expect(hudConfig().cacheMax).toBe(300);
    // 0 is meaningful for the TTL: it is how the cache is switched off.
    vi.stubEnv("HUD_CACHE_TTL_MS", "0");
    expect(hudConfig().cacheTtlMs).toBe(0);
  });

  it("keeps a valid value", () => {
    vi.stubEnv("HUD_HTTP_ATTEMPTS", "2");
    vi.stubEnv("HUD_RETRY_BACKOFF_MS", "250,750");
    vi.stubEnv("HUD_CACHE_TTL_MS", "60000");
    vi.stubEnv("HUD_CACHE_MAX", "5");
    expect(hudConfig()).toEqual({ attempts: 2, retryBackoffMs: [250, 750], cacheTtlMs: 60000, cacheMax: 5 });
  });

  it("waits the configured backoff between attempts", async () => {
    // The suite runs on a flattened ladder, so this is the one place that pins
    // the ladder to the clock. To pin anything the ladder has to CLEAR the
    // throttle floor: every attempt also goes through throttled(), which spaces
    // request STARTS by REQUEST_GAP_MS, so three attempts already cost ~2 x
    // 150ms with no backoff at all. Measured on this repo against a 429-always
    // fetch: ladder "0,0" -> 324ms, "60,60" -> 317ms, i.e. a 60ms ladder is
    // entirely absorbed and the two are indistinguishable. At 400ms a rung the
    // sleep is the dominant term and deleting it turns this red.
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubEnv("HUD_RETRY_BACKOFF_MS", "400,400");
    const busy = mockFetch({ error: "rate limited" }, 429);
    vi.stubGlobal("fetch", busy);
    const client = await connect();
    const started = Date.now();
    const res: any = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    const elapsed = Date.now() - started;
    expect(res.isError).toBe(true);
    expect(busy).toHaveBeenCalledTimes(3);
    expect(elapsed).toBeGreaterThan(2 * REQUEST_GAP_MS); // the floor a dropped backoff stops at
    expect(elapsed).toBeGreaterThanOrEqual(2 * 400 - 20); // 2 x 400ms, less timer slop
  });

  it("gives up rather than sleep past the retry deadline", async () => {
    // withRetry's other exit: RETRY_DEADLINE_MS bounds total wall clock, because
    // an MCP client has its own call timeout and three stacked 15s HTTP timeouts
    // would blow past it. Nothing exercised that break, and a suite pinned to a
    // 0ms ladder can never reach it by accident -- the ladder has to be long
    // enough that the NEXT attempt could not finish in time: deadline 40s less
    // the 15s HTTP timeout leaves 25s, so a 30s rung is over the line on the
    // first failure. The give-up is therefore instant, which is the assertion.
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubEnv("HUD_RETRY_BACKOFF_MS", "30000");
    const busy = mockFetch({ error: "rate limited" }, 429);
    vi.stubGlobal("fetch", busy);
    const client = await connect();
    const started = Date.now();
    const res: any = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    const elapsed = Date.now() - started;
    expect(res.isError).toBe(true);
    // A 429 is retryable, so only the deadline can stop it at one attempt.
    expect(busy).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(2000);
    // And it reports HUD's own failure, not the deadline as if it were one.
    expect(String(res.content[0].text)).toMatch(/HUD \/fmr\/data\/3600599999/);
  });

  it("a nonsense HUD_HTTP_ATTEMPTS still makes the request and reports the real error", async () => {
    // Before: Number("oops") = NaN, the for-loop never executed, and the server
    // threw an unassigned `last` -- the tool answered "Error: undefined", which
    // names neither HUD nor the network.
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubEnv("HUD_HTTP_ATTEMPTS", "oops");
    const bad = mockFetch({ error: "upstream" }, 503);
    vi.stubGlobal("fetch", bad);
    const client = await connect();
    const res: any = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("HUD /fmr/data/3600599999");
    expect(res.content[0].text).not.toContain("undefined");
    expect(bad).toHaveBeenCalledTimes(3); // the documented default, not zero
  });

  it("honours a valid cache TTL, so the knob is wired and not just parsed", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubEnv("HUD_CACHE_TTL_MS", "1");
    const f = mockFetch({ data: { basicdata: { Efficiency: 1 } } });
    vi.stubGlobal("fetch", f);
    const client = await connect();
    await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    await new Promise((r) => setTimeout(r, 20)); // past a 1ms TTL by 20x
    await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("honours a valid cache bound, evicting the oldest entry", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubEnv("HUD_CACHE_MAX", "2");
    const f = mockFetch({ data: { basicdata: { Efficiency: 1 } } });
    vi.stubGlobal("fetch", f);
    const client = await connect();
    for (const year of ["2025", "2026", "2027"]) {
      await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999", year } });
    }
    expect(f).toHaveBeenCalledTimes(3);
    // 2025 was pushed out by 2027, so it has to be fetched again.
    await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999", year: "2025" } });
    expect(f).toHaveBeenCalledTimes(4);
  });
});

describe("response cache", () => {
  // HUD publishes FMR on an annual cycle, so a repeat lookup in one session
  // cannot have a different answer.
  it("serves a repeated lookup without a second request", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const f = mockFetch({ data: { basicdata: [{ zip_code: "10451", Efficiency: 1, "One-Bedroom": 2 }] } });
    vi.stubGlobal("fetch", f);
    const client = await connect();
    await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("treats different params as different keys", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    // Same entityid so the PATH is identical; only `year` differs, which lands in
    // params. An earlier version of this test varied the entityid instead, which
    // varies the path -- so a key built from the path alone still passed it. Fault
    // injection caught that; this version fails if params leave the key.
    const f = mockFetch({ data: { basicdata: [{ zip_code: "10451", Efficiency: 1, "One-Bedroom": 2 }] } });
    vi.stubGlobal("fetch", f);
    const client = await connect();
    await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999", year: 2025 } });
    await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999", year: 2026 } });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const bad = mockFetch({ error: "boom" }, 500);
    vi.stubGlobal("fetch", bad);
    const client = await connect();
    const r1: any = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    expect(r1.isError).toBe(true);
    const good = mockFetch({ data: { basicdata: [{ zip_code: "10451", Efficiency: 1, "One-Bedroom": 2 }] } });
    vi.stubGlobal("fetch", good);
    const r2: any = await client.callTool({ name: "fmr_lookup", arguments: { entityid: "3600599999" } });
    expect(r2.isError).toBeFalsy();
    expect(good).toHaveBeenCalled();
  });
});
