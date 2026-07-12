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

// affordability_check: the arithmetic the raw tables leave to the caller, done
// server-side from the SAME shaped data fmr_lookup / income_limits return.
const BEDROOM_FIELDS = ["efficiency", "one_br", "two_br", "three_br", "four_br"] as const;
const BEDROOM_LABELS = ["efficiency (studio)", "one-bedroom", "two-bedroom", "three-bedroom", "four-bedroom"] as const;
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

function shapeAffordability(input: {
  entityid: string;
  fmrData?: any;
  ilData?: any;
  rent?: number;
  bedrooms?: number;
  income?: number;
  size?: number;
}) {
  const { entityid, fmrData, ilData, rent, bedrooms, income, size } = input;
  const shapedFmr = fmrData !== undefined ? shapeFmr(fmrData) : undefined;
  const shapedIl = ilData !== undefined ? shapeIncomeLimits(ilData, size) : undefined;
  const area = shapedFmr?.area || shapedIl?.area || "this area";

  let rent_check: any;
  if (rent !== undefined && bedrooms !== undefined && shapedFmr) {
    const fmrs = shapedFmr.fair_market_rents;
    if (Array.isArray(fmrs)) {
      throw new Error(
        "this area's FMR data has multiple rows (small-area/ZIP-level or multi-year); affordability_check compares one row — use a county entityid (county FIPS + 99999), or fmr_lookup to see every row",
      );
    }
    const raw = (fmrs as any)[BEDROOM_FIELDS[bedrooms]];
    const fmr = Number(raw);
    if (raw === undefined || raw === null || !Number.isFinite(fmr)) {
      throw new Error(`HUD's FMR table for ${area} has no ${BEDROOM_LABELS[bedrooms]} line`);
    }
    const year = (fmrs as any).year;
    const label = BEDROOM_LABELS[bedrooms];
    const delta = round(rent - fmr, 2);
    const delta_pct = fmr > 0 ? round(((rent - fmr) / fmr) * 100, 1) : null;
    const verdict =
      delta === 0
        ? `rent ${money(rent)} is exactly the ${year} Fair Market Rent for a ${label} in ${area}`
        : `rent ${money(rent)} is ${money(Math.abs(delta))}${delta_pct === null ? "" : ` (${Math.abs(delta_pct)}%)`} ${delta > 0 ? "above" : "below"} the ${year} Fair Market Rent of ${money(fmr)} for a ${label} in ${area}`;
    rent_check = {
      rent,
      bedrooms,
      fmr,
      year,
      delta, // rent - FMR; positive = above FMR
      delta_pct,
      above_fmr: delta > 0,
      verdict,
      note: "Section 8 payment standards are set by the local housing authority, typically at 90-110% of FMR (24 CFR 982.503), so a rent slightly above FMR can still fall within a voucher's payment standard.",
    };
  }

  let income_check: any;
  if (income !== undefined && size !== undefined && shapedIl) {
    const bands = [
      { key: "extremely_low_30pct", name: "extremely low income", pct: "30% of area median" },
      { key: "very_low_50pct", name: "very low income", pct: "50% of area median" },
      { key: "low_80pct", name: "low income", pct: "80% of area median" },
    ] as const;
    const categories: Record<string, { limit: number; qualifies: boolean; readout: string }> = {};
    let lowestQualified: (typeof bands)[number] | undefined;
    for (const band of bands) {
      const limit = Number((shapedIl as any)[band.key]);
      if (!Number.isFinite(limit)) continue; // band missing from HUD's table: leave it out rather than compare against NaN
      const qualifies = income <= limit; // HUD limits are at-or-below
      if (qualifies && !lowestQualified) lowestQualified = band;
      const voucherTag = band.key === "very_low_50pct" ? " — the usual Section 8 voucher income limit" : "";
      categories[band.key] = {
        limit,
        qualifies,
        readout: qualifies
          ? `qualifies as ${band.name}: ${money(income)} is at or below the ${money(limit)} limit (${band.pct}) for a ${size}-person household${voucherTag}`
          : `does not qualify as ${band.name}: ${money(income)} is above the ${money(limit)} limit (${band.pct}) for a ${size}-person household${voucherTag}`,
      };
    }
    if (Object.keys(categories).length === 0) {
      throw new Error(`HUD's income-limit table for ${area} has no ${size}-person column`);
    }
    const year = shapedIl.year;
    const ami = Number(shapedIl.median_income);
    const verdict = lowestQualified
      ? `a ${size}-person household with annual income ${money(income)} in ${area} is ${lowestQualified.name} (at or below ${lowestQualified.pct}) under the ${year} HUD income limits${
          lowestQualified.key === "low_80pct"
            ? " — above the usual Section 8 voucher line (50% of area median) but within the 80% line many HUD programs use"
            : " — generally income-eligible for a Section 8 voucher"
        }`
      : `a ${size}-person household with annual income ${money(income)} in ${area} is above every ${year} HUD income-limit line (over 80% of area median) — not income-eligible under these categories`;
    income_check = {
      income,
      household_size: size,
      year, // which year's table answered
      area_median_income: Number.isFinite(ami) ? ami : undefined,
      categories,
      verdict,
    };
  }

  return { entityid, area, rent_check, income_check };
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
        name: "affordability_check",
        description:
          "Affordability verdicts computed server-side from the same HUD tables as fmr_lookup and income_limits: whether a proposed rent is above or below the Fair Market Rent for a bedroom size (dollar and percent gap), and which HUD income bands a household qualifies under (extremely low 30%, very low 50% = the Section 8 voucher line, low 80% of area median). Pass rent + bedrooms, income + household_size, or all four; returns the verdicts with the underlying numbers and table year for citation. entityid is a 10-digit county FIPS or a metro CBSA code (same as fmr_lookup).",
        inputSchema: {
          type: "object",
          properties: {
            entityid: { type: "string", description: "10-digit county entity id (county FIPS + 99999) or metro CBSA code. Derive from a ZIP via zip_crosswalk then list_counties" },
            rent: { type: "number", description: "Proposed monthly rent in dollars, to compare against the FMR for the given bedrooms" },
            bedrooms: { type: "number", description: "Bedroom count 0-4 (0 = efficiency/studio); required when rent is given" },
            income: { type: "number", description: "Annual gross household income in dollars, to compare against the 30/50/80% area-median lines" },
            household_size: { type: "number", description: "Family size 1-8; required when income is given" },
            year: { type: "string", description: "Table year (e.g. '2026'); default is the latest" },
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
      case "affordability_check": {
        const id = String(args.entityid ?? "").trim();
        if (!id) {
          throw new Error("entityid is required (10-digit county FIPS + 99999 or metro CBSA code; derive from a ZIP via zip_crosswalk then list_counties)");
        }
        const hasRent = args.rent !== undefined && args.rent !== null;
        const hasIncome = args.income !== undefined && args.income !== null;
        if (!hasRent && !hasIncome) {
          throw new Error(
            "nothing to check: pass rent (with bedrooms) for a rent-vs-FMR verdict, income (with household_size) for an income-qualification verdict, or both. For the raw tables use fmr_lookup / income_limits.",
          );
        }
        let rent: number | undefined;
        let bedrooms: number | undefined;
        if (hasRent) {
          rent = Number(args.rent);
          if (!Number.isFinite(rent) || rent <= 0) throw new Error("rent must be a positive monthly dollar amount");
          if (args.bedrooms === undefined || args.bedrooms === null) {
            throw new Error("bedrooms is required when rent is given, so the verdict compares the right FMR line (0 = efficiency/studio, through 4)");
          }
          bedrooms = Number(args.bedrooms);
          if (!Number.isInteger(bedrooms) || bedrooms < 0 || bedrooms > 4) {
            throw new Error("bedrooms must be an integer 0-4 (0 = efficiency/studio; HUD FMR tables stop at four bedrooms)");
          }
        }
        let income: number | undefined;
        let size: number | undefined;
        if (hasIncome) {
          income = Number(args.income);
          if (!Number.isFinite(income) || income < 0) throw new Error("income must be a non-negative annual dollar amount");
          if (args.household_size === undefined || args.household_size === null) {
            throw new Error("household_size is required when income is given, so the verdict compares the right income-limit column (1-8)");
          }
          size = Number(args.household_size);
          if (!Number.isInteger(size) || size < 1 || size > 8) {
            throw new Error(
              "household_size must be an integer 1-8 — HUD income-limit tables stop at 8 people (for a larger household, HUD's convention is the 8-person limit plus 8% of the 4-person limit per additional person, computed from income_limits)",
            );
          }
        }
        const params: Record<string, string> = {};
        if (args.year) params.year = String(args.year);
        const [fmrData, ilData] = await Promise.all([
          hasRent ? hudGet(`/fmr/data/${encodeURIComponent(id)}`, params) : Promise.resolve(undefined),
          hasIncome ? hudGet(`/il/data/${encodeURIComponent(id)}`, params) : Promise.resolve(undefined),
        ]);
        return asJson(shapeAffordability({ entityid: id, fmrData, ilData, rent, bedrooms, income, size }));
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
