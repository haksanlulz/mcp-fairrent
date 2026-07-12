import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server";

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

  it("exposes all five tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "fmr_lookup",
      "income_limits",
      "list_counties",
      "list_metro_areas",
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
    await expect(
      client.callTool({ name: "income_limits", arguments: { entityid: "x", household_size: 9 } }),
    ).rejects.toThrow(/1-8/);
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
    expect(body.matches[0].res_ratio).toBe("1.0");
  });

  it("zip_crosswalk rejects a non-5-digit ZIP and an unknown target", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    const client = await connect();
    await expect(
      client.callTool({ name: "zip_crosswalk", arguments: { zip: "1045" } }),
    ).rejects.toThrow(/5-digit/);
    await expect(
      client.callTool({ name: "zip_crosswalk", arguments: { zip: "10451", to: "planet" } }),
    ).rejects.toThrow(/unknown target/);
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
    await expect(
      client.callTool({ name: "fmr_lookup", arguments: { entityid: "NY" } }),
    ).rejects.toThrow(/huduser\.gov/);
  });

  it("surfaces a HUD error body instead of returning junk", async () => {
    vi.stubEnv("HUD_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", mockFetch({ error: "Unauthenticated" }, 401));
    const client = await connect();
    await expect(
      client.callTool({ name: "fmr_lookup", arguments: { entityid: "NY" } }),
    ).rejects.toThrow(/Unauthenticated/);
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
});
