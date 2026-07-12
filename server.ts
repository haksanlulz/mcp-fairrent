/**
 * mcp-fairrent server — HUD housing affordability data: Fair Market Rents,
 * Section 8 income limits, and the USPS ZIP-to-jurisdiction crosswalk that
 * ties an address to the right FMR/income-limit area. index.ts is the stdio
 * entry point.
 *
 * All data comes from the HUD USER Public Data API. Field shapes below match
 * HUD's documented response examples; smoke.ts checks them against the live
 * API (needs a token).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const HUD_API = "https://www.huduser.gov/hudapi/public";
const CONTACT = process.env.HUD_CONTACT || "mcp-fairrent (github.com/haksanlulz/mcp-fairrent)";
const UA = `mcp-fairrent/1.0 (${CONTACT})`;

// USPS crosswalk type codes (HUD): source geography -> target geography.
const CROSSWALK_TYPES: Record<string, number> = {
  tract: 1, // ZIP -> Census tract
  county: 2, // ZIP -> county
  cbsa: 3, // ZIP -> CBSA (metro)
  cd: 5, // ZIP -> congressional district
};

// HUD USER allows ~60 requests/min; space request STARTS by a fixed gap so the
// rate is bounded by REQUEST_GAP_MS no matter how long each response takes.
export const REQUEST_GAP_MS = 150;
let lastStart = 0;
let queue: Promise<unknown> = Promise.resolve();
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const sinceLast = Date.now() - lastStart;
    if (sinceLast < REQUEST_GAP_MS) {
      await new Promise((r) => setTimeout(r, REQUEST_GAP_MS - sinceLast));
    }
    lastStart = Date.now(); // stamp the START before the fetch, so spacing is start-to-start
    return fn();
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function token(): string {
  const t = process.env.HUD_API_TOKEN;
  if (!t) {
    throw new Error(
      "HUD_API_TOKEN is not set. Get a free token at https://www.huduser.gov/portal/dataset/fmr-api.html (one-screen signup) and set HUD_API_TOKEN.",
    );
  }
  return t;
}

async function hudGet(path: string, params: Record<string, string> = {}): Promise<any> {
  return throttled(async () => {
    const qs = new URLSearchParams(params);
    const url = `${HUD_API}${path}${qs.toString() ? `?${qs}` : ""}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA, Authorization: `Bearer ${token()}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`HUD ${path} returned non-JSON (status ${res.status}): ${body.slice(0, 200)}`);
    }
    if (!res.ok || json.error) {
      throw new Error(`HUD ${path} error (status ${res.status}): ${json.error ?? body.slice(0, 200)}`);
    }
    return json.data ?? json;
  });
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function asJson(v: unknown) {
  return text(JSON.stringify(v, null, 2));
}

// FMR basicdata is an object {Efficiency, One-Bedroom, ...} for a single area,
// or an array of such objects (metro breakdowns / multiple years). Normalize.
function shapeFmr(data: any) {
  const topYear = data?.year; // small-area/metro array rows carry no per-row year
  const rentsOf = (b: any) => ({
    year: b?.year ?? topYear,
    efficiency: b?.Efficiency,
    one_br: b?.["One-Bedroom"],
    two_br: b?.["Two-Bedroom"],
    three_br: b?.["Three-Bedroom"],
    four_br: b?.["Four-Bedroom"],
    zip_code: b?.zip_code,
  });
  const bd = data?.basicdata;
  return {
    area: data?.county_name || data?.metro_name || data?.town_name,
    counties_msa: data?.counties_msa || undefined,
    metro_name: data?.metro_name || undefined,
    is_metro: data?.metro_status === "1",
    small_area_fmrs: data?.smallarea_status === "1",
    fair_market_rents: Array.isArray(bd) ? bd.map(rentsOf) : rentsOf(bd),
  };
}

// IL nests very_low / extremely_low / low, each with il{50,30,80}_p1..p8.
function shapeIncomeLimits(data: any, size?: number) {
  const pick = (block: any, prefix: string) => {
    if (!block) return undefined;
    if (size && size >= 1 && size <= 8) return block[`${prefix}_p${size}`];
    return Array.from({ length: 8 }, (_, i) => block[`${prefix}_p${i + 1}`]);
  };
  return {
    area: data?.county_name || data?.metro_name,
    metro_name: data?.metro_name || undefined,
    year: data?.year,
    median_income: data?.median_income,
    household_size: size,
    extremely_low_30pct: pick(data?.extremely_low, "il30"),
    very_low_50pct: pick(data?.very_low, "il50"),
    low_80pct: pick(data?.low, "il80"),
  };
}

export function createServer() {
  const server = new Server(
    { name: "mcp-fairrent", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "fmr_lookup",
        description:
          "HUD Fair Market Rent (the rent a modest unit should cost) for an area, by bedroom count. entityid is a HUD entity id: a 10-digit county FIPS (e.g. 3600599999 for Bronx County = 36005 + 99999) or a metro CBSA code. Use zip_crosswalk then list_counties to turn a ZIP into a county entityid.",
        inputSchema: {
          type: "object",
          properties: {
            entityid: { type: "string", description: "10-digit county entity id (county FIPS + 99999) or metro CBSA code. Derive from a ZIP via zip_crosswalk then list_counties" },
            year: { type: "string", description: "FMR year (e.g. '2026'); default is the latest" },
          },
          required: ["entityid"],
        },
      },
      {
        name: "income_limits",
        description:
          "HUD income limits for an area: the extremely-low (30% AMI), very-low (50%, the Section 8 voucher line), and low (80%) income thresholds, by household size. Pass household_size (1-8) to get the single threshold that applies to a family that size. entityid is a 10-digit county FIPS or a metro CBSA code (same as fmr_lookup).",
        inputSchema: {
          type: "object",
          properties: {
            entityid: { type: "string", description: "10-digit county entity id (county FIPS + 99999) or metro CBSA code. Derive from a ZIP via zip_crosswalk then list_counties" },
            household_size: { type: "number", description: "Family size 1-8; omit for all sizes" },
            year: { type: "string", description: "Income-limit year; default is the latest" },
          },
          required: ["entityid"],
        },
      },
      {
        name: "zip_crosswalk",
        description:
          "Map a 5-digit ZIP to the county, tract, CBSA (metro), or congressional district it falls in, using the HUD-USPS crosswalk. Returns each matching geography with its residential-address share (res_ratio); the highest-share county is the one to resolve into an entityid via list_counties.",
        inputSchema: {
          type: "object",
          properties: {
            zip: { type: "string", description: "5-digit ZIP code" },
            to: { type: "string", description: "Target geography: county | tract | cbsa | cd (default county)" },
            year: { type: "string", description: "Crosswalk year; default is the latest" },
          },
          required: ["zip"],
        },
      },
      {
        name: "list_counties",
        description:
          "List the counties in a state with their 10-digit FIPS entity ids, so you can look up FMR or income limits by county name. Pass a 2-letter state code.",
        inputSchema: {
          type: "object",
          properties: {
            state: { type: "string", description: "2-letter state code (e.g. 'NY')" },
          },
          required: ["state"],
        },
      },
      {
        name: "list_metro_areas",
        description: "List HUD metropolitan areas (CBSAs) with their codes, for metro-level FMR and income-limit lookups.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    switch (name) {
      case "fmr_lookup": {
        const id = String(args.entityid ?? "").trim();
        if (!id) throw new Error("entityid is required (state code, county FIPS, CBSA, or ZIP)");
        const params: Record<string, string> = {};
        if (args.year) params.year = String(args.year);
        const data = await hudGet(`/fmr/data/${encodeURIComponent(id)}`, params);
        return asJson(shapeFmr(data));
      }
      case "income_limits": {
        const id = String(args.entityid ?? "").trim();
        if (!id) throw new Error("entityid is required (state code, county FIPS, or CBSA)");
        const size = args.household_size !== undefined ? Number(args.household_size) : undefined;
        if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > 8)) {
          throw new Error("household_size must be an integer 1-8");
        }
        const params: Record<string, string> = {};
        if (args.year) params.year = String(args.year);
        const data = await hudGet(`/il/data/${encodeURIComponent(id)}`, params);
        return asJson(shapeIncomeLimits(data, size));
      }
      case "zip_crosswalk": {
        const zip = String(args.zip ?? "").trim();
        if (!/^\d{5}$/.test(zip)) throw new Error("zip must be a 5-digit ZIP code");
        const to = String(args.to ?? "county").toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(CROSSWALK_TYPES, to)) {
          throw new Error(`unknown target '${to}'; use one of: ${Object.keys(CROSSWALK_TYPES).join(", ")}`);
        }
        const type = CROSSWALK_TYPES[to];
        const params: Record<string, string> = { type: String(type), query: zip };
        if (args.year) params.year = String(args.year);
        const data = await hudGet(`/usps`, params);
        const results = (data?.results ?? []).map((r: any) => ({
          geoid: r.geoid,
          res_ratio: r.res_ratio,
          bus_ratio: r.bus_ratio,
          tot_ratio: r.tot_ratio,
        }));
        return asJson({ zip, to, matches: results });
      }
      case "list_counties": {
        const state = String(args.state ?? "").trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(state)) throw new Error("state must be a 2-letter code (e.g. 'NY')");
        const data = await hudGet(`/fmr/listCounties/${state}`);
        const counties = (Array.isArray(data) ? data : []).map((c: any) => ({
          county_name: c.county_name,
          fips_code: c.fips_code,
          state_code: c.state_code,
        }));
        return asJson({ state, counties });
      }
      case "list_metro_areas": {
        const data = await hudGet(`/fmr/listMetroAreas`);
        const metros = (Array.isArray(data) ? data : []).map((m: any) => ({
          cbsa_code: m.cbsa_code,
          area_name: m.area_name,
          category: m.category,
        }));
        return asJson({ metros });
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}
