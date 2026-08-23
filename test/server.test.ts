import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, REQUEST_GAP_MS } from "../server";

async function connect(): Promise<Client> {
  const server = createServer();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

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

// Response shapes below mirror HUD's documented API examples (fmr/il/usps/list);
// field names are quoted from HUD's own response samples.
const FMR_PAYLOAD = {
  data: {
    county_name: "Bronx County",
    counties_msa: "New York-White Plains, NY-NJ HUD Metro FMR Area",
    town_name: "",
    metro_status: "1",
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
          metro_status: "1",
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
      mockFetch({ data: { metro_name: "M", metro_status: "1", year: "2026", basicdata: [{ zip_code: "10451", "Two-Bedroom": "2213.0" }] } }),
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
    for (const name of ["fmr_lookup", "income_limits", "affordability_check"]) {
      const tool = tools.find((t) => t.name === name)!;
      const desc = (tool.inputSchema.properties as any).entityid.description as string;
      expect(desc).toContain("zip_crosswalk");
      expect(desc).toContain("99999");
    }
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
        mockFetch({ data: { metro_name: "M", metro_status: "1", smallarea_status: "1", year: "2026", basicdata: [{ zip_code: "10451", "Two-Bedroom": "2213.0" }] } }),
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

const STATEDATA_PAYLOAD = {
  data: {
    year: "2026",
    metroareas: [
      { code: "METRO35620M35620", name: "New York-White Plains", state_code: "NY", Efficiency: "1875", "One-Bedroom": "1945", "Two-Bedroom": "2213", "Three-Bedroom": "2818", "Four-Bedroom": "3015", smallarea_status: "1" },
    ],
    counties: [
      { county_name: "Albany County", fips_code: "3600199999", metro_name: "Albany-Schenectady-Troy", Efficiency: "900", "One-Bedroom": "1000", "Two-Bedroom": "1200", "Three-Bedroom": "1500", "Four-Bedroom": "1700", smallarea_status: "0" },
    ],
  },
};

const REVERSE_CROSSWALK_PAYLOAD = {
  data: {
    year: "2026",
    quarter: "1",
    input: "36005",
    crosswalk_type: "county-zip",
    results: [
      { zip: "10451", city: "BRONX", state: "NY", res_ratio: "0.05", bus_ratio: "0.04", oth_ratio: "0.05", tot_ratio: "0.05" },
      { zip: "10452", city: "BRONX", state: "NY", res_ratio: "0.07", bus_ratio: "0.03", oth_ratio: "0.06", tot_ratio: "0.06" },
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
    expect(body.counties[0].two_br).toBe("1200");
    expect(body.eligibility_scope).toBeDefined();
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
