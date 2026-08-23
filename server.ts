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
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

const HUD_API = "https://www.huduser.gov/hudapi/public";
const CONTACT = process.env.HUD_CONTACT || "mcp-fairrent (github.com/haksanlulz/mcp-fairrent)";
const UA = `mcp-fairrent/1.0 (${CONTACT})`;

// USPS crosswalk type codes (HUD; full 12-type table verified against the
// API docs 2026-08-23). zip_crosswalk uses the ZIP->geography half; geo_to_zips
// uses the geography->ZIP half.
const CROSSWALK_TYPES: Record<string, number> = {
  tract: 1, // ZIP -> Census tract
  county: 2, // ZIP -> county
  cbsa: 3, // ZIP -> CBSA (metro)
  cbsa_div: 4, // ZIP -> CBSA division
  cd: 5, // ZIP -> congressional district
  county_sub: 11, // ZIP -> county subdivision
};
const REVERSE_CROSSWALK_TYPES: Record<string, number> = {
  tract: 6, // Census tract -> ZIPs
  county: 7, // county -> ZIPs
  cbsa: 8, // CBSA (metro) -> ZIPs
  cbsa_div: 9, // CBSA division -> ZIPs
  cd: 10, // congressional district -> ZIPs
  county_sub: 12, // county subdivision -> ZIPs
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
      // json.error can be an object; stringify it rather than shipping "[object Object]".
      const detail = json.error !== undefined
        ? (typeof json.error === "string" ? json.error : JSON.stringify(json.error))
        : body.slice(0, 200);
      throw new Error(`HUD ${path} error (status ${res.status}): ${detail}`);
    }
    return json.data ?? json;
  });
}

// USPS ratios arrive at full double precision (0.044077448175895165); four
// decimal places is more than address-share data supports and far easier on
// the reader.
function ratio(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : undefined;
}

// HUD signals "no rows for that value" as HTTP 404 wrapping [{error: "No data
// found using the value ..."}] (verified live 2026-08-23 with the retired ZIP
// 10048). For the crosswalk tools that is an ANSWER, not an error.
function isNoDataError(err: unknown): boolean {
  return err instanceof Error && /No data found using the value/i.test(err.message);
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

// MTSP (Multifamily Tax Subsidy Projects) income limits: the LIHTC bands.
// Nests 20/30/40/50/60/70/80percent plus the HERA special 50/60 bands, each
// with il{pct}_p1..p8 columns (hera_special_il{pct}_pN for the HERA bands).
function shapeMtsp(data: any, size?: number) {
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
    pct_20: pick(data?.["20percent"], "il20"),
    pct_30: pick(data?.["30percent"], "il30"),
    pct_40: pick(data?.["40percent"], "il40"),
    pct_50: pick(data?.["50percent"], "il50"),
    pct_60: pick(data?.["60percent"], "il60"),
    pct_70: pick(data?.["70percent"], "il70"),
    pct_80: pick(data?.["80percent"], "il80"),
    hera_special_50: pick(data?.hera_special_50percent, "hera_special_il50"),
    hera_special_60: pick(data?.hera_special_60percent, "hera_special_il60"),
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

/**
 * SPEC limits-not-eligibility.
 *
 * Every number this server returns is a PROGRAM LINE, and the wrong reading is
 * treating it as a personal determination. The note rides every payload (the
 * sibling servers' pattern): FMRs are not payment standards (PHAs set those at
 * 90-110% of FMR, and small-area ZIPs differ); income limits are the federal
 * eligibility lines, not an award of a voucher (waitlists and preferences
 * decide that); MTSP limits govern tax-credit buildings, not Section 8. Each
 * answer is exactly as current as its table year.
 */
const ELIGIBILITY_SCOPE =
  "HUD program tables, reproduced as published. Rent figures are Fair Market " +
  "Rents, not a housing authority's payment standard; income figures are " +
  "program eligibility lines, not a determination or an award. Confirm with " +
  "the administering agency before relying on a number for a real household.";

function withScope<T extends Record<string, unknown>>(result: T): T & { eligibility_scope: string } {
  return { ...result, eligibility_scope: ELIGIBILITY_SCOPE };
}

export function createServer() {
  const server = new Server(
    { name: "mcp-fairrent", version: "1.1.0" },
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
            to: { type: "string", description: "Target geography: county | tract | cbsa | cbsa_div | cd | county_sub (default county)" },
            year: { type: "string", description: "Crosswalk year; default is the latest" },
          },
          required: ["zip"],
        },
      },
      {
        name: "mtsp_income_limits",
        description:
          "MTSP (Multifamily Tax Subsidy Projects) income limits: the bands used by LIHTC tax-credit buildings, at 20/30/40/50/60/70/80% of area median plus the HERA special bands. These are the limits that decide eligibility for tax-credit apartments, and they are NOT the same table as the Section 8 income limits (use income_limits for those). entityid is a 10-digit county FIPS or metro CBSA code, same as fmr_lookup.",
        inputSchema: {
          type: "object",
          properties: {
            entityid: { type: "string", description: "10-digit county entity id (county FIPS + 99999) or metro CBSA code. Derive from a ZIP via zip_crosswalk then list_counties" },
            household_size: { type: "number", description: "Family size 1-8; omit for all sizes" },
            year: { type: "string", description: "Table year; default is the latest" },
          },
          required: ["entityid"],
        },
      },
      {
        name: "state_fmr_overview",
        description:
          "Every county's and metro area's Fair Market Rents for a whole state in ONE call (/fmr/statedata). Use this to compare areas, find where a budget reaches, or scan a region without one fmr_lookup per county. Returns metro areas and counties with all five bedroom-size FMRs and small-area status. Pass a 2-letter state code.",
        inputSchema: {
          type: "object",
          properties: {
            state: { type: "string", description: "2-letter state code (e.g. 'NY')" },
            year: { type: "string", description: "FMR year; default is the latest" },
          },
          required: ["state"],
        },
      },
      {
        name: "geo_to_zips",
        description:
          "The reverse crosswalk: every ZIP code inside a county, Census tract, metro (CBSA), CBSA division, congressional district, or county subdivision, with each ZIP's residential-address share. Useful for walking a district or scoping a county to mailable ZIPs. Pass the geography type and its GEOID (county = 5-digit FIPS, tract = 11-digit, cd = 4-digit, cbsa = 5-digit).",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "Source geography: county | tract | cbsa | cbsa_div | cd | county_sub" },
            geoid: { type: "string", description: "The geography's GEOID (e.g. county '36005', congressional district '3615')" },
            year: { type: "string", description: "Crosswalk year; default is the latest" },
          },
          required: ["from", "geoid"],
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
    try {
      return await dispatch(name, args as Record<string, any>);
    } catch (err) {
      if (err instanceof McpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  });

  async function dispatch(name: string, args: Record<string, any>) {
    switch (name) {
      case "fmr_lookup": {
        const id = String(args.entityid ?? "").trim();
        if (!id) throw new Error("entityid is required (state code, county FIPS, CBSA, or ZIP)");
        const params: Record<string, string> = {};
        if (args.year) params.year = String(args.year);
        const data = await hudGet(`/fmr/data/${encodeURIComponent(id)}`, params);
        return asJson(withScope(shapeFmr(data)));
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
        return asJson(withScope(shapeIncomeLimits(data, size)));
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
        return asJson(withScope(shapeAffordability({ entityid: id, fmrData, ilData, rent, bedrooms, income, size })));
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
        let data: any;
        try {
          data = await hudGet(`/usps`, params);
        } catch (err) {
          if (!isNoDataError(err)) throw err;
          data = { results: [] }; // a retired / PO-box-only / unknown ZIP is an answer
        }
        const results = (data?.results ?? []).map((r: any) => ({
          geoid: r.geoid,
          city: r.city,
          state: r.state,
          res_ratio: ratio(r.res_ratio),
          bus_ratio: ratio(r.bus_ratio),
          tot_ratio: ratio(r.tot_ratio),
        }));
        return asJson(
          withScope({
            zip,
            to,
            note:
              results.length === 0
                ? "No crosswalk rows for that ZIP. It may be a PO-box-only or single-building ZIP with no residential addresses, or not a current USPS ZIP; verify the ZIP before concluding anything."
                : "res_ratio is the share of the ZIP's residential addresses in each geography; the highest-share county is usually the right entityid.",
            matches: results,
          }),
        );
      }
      case "mtsp_income_limits": {
        const id = String(args.entityid ?? "").trim();
        if (!id) throw new Error("entityid is required (10-digit county FIPS + 99999 or metro CBSA code)");
        const size = args.household_size !== undefined ? Number(args.household_size) : undefined;
        if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > 8)) {
          throw new Error("household_size must be an integer 1-8");
        }
        const params: Record<string, string> = {};
        if (args.year) params.year = String(args.year);
        const data = await hudGet(`/mtspil/data/${encodeURIComponent(id)}`, params);
        return asJson(withScope(shapeMtsp(data, size)));
      }
      case "state_fmr_overview": {
        const state = String(args.state ?? "").trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(state)) throw new Error("state must be a 2-letter code (e.g. 'NY')");
        const params: Record<string, string> = {};
        if (args.year) params.year = String(args.year);
        const data = await hudGet(`/fmr/statedata/${state}`, params);
        const shapeRow = (r: any) => ({
          name: r.county_name || r.name || r.town_name,
          code: r.fips_code || r.code,
          metro_name: r.metro_name || undefined,
          efficiency: r.Efficiency,
          one_br: r["One-Bedroom"],
          two_br: r["Two-Bedroom"],
          three_br: r["Three-Bedroom"],
          four_br: r["Four-Bedroom"],
          small_area_fmrs: r.smallarea_status === "1" || r.smallarea_status === 1,
        });
        return asJson(
          withScope({
            state,
            year: data?.year,
            metro_areas: (data?.metroareas ?? []).map(shapeRow),
            counties: (data?.counties ?? []).map(shapeRow),
          }),
        );
      }
      case "geo_to_zips": {
        const from = String(args.from ?? "").toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(REVERSE_CROSSWALK_TYPES, from)) {
          throw new Error(`unknown source geography '${from}'; use one of: ${Object.keys(REVERSE_CROSSWALK_TYPES).join(", ")}`);
        }
        const geoid = String(args.geoid ?? "").trim();
        if (!/^\d{2,11}$/.test(geoid)) throw new Error("geoid must be the geography's numeric GEOID (2-11 digits)");
        const params: Record<string, string> = { type: String(REVERSE_CROSSWALK_TYPES[from]), query: geoid };
        if (args.year) params.year = String(args.year);
        let data: any;
        try {
          data = await hudGet(`/usps`, params);
        } catch (err) {
          if (!isNoDataError(err)) throw err;
          data = { results: [] };
        }
        const results = (data?.results ?? []).map((r: any) => ({
          zip: r.zip ?? r.geoid,
          city: r.city,
          state: r.state,
          res_ratio: ratio(r.res_ratio),
          bus_ratio: ratio(r.bus_ratio),
          tot_ratio: ratio(r.tot_ratio),
        }));
        return asJson(
          withScope({
            from,
            geoid,
            zip_count: results.length,
            note:
              results.length === 0
                ? "No ZIPs matched. Check the GEOID length for the geography type (county = 5-digit FIPS, tract = 11-digit, congressional district = 4-digit state+district)."
                : "res_ratio is the share of the geography's residential addresses in that ZIP.",
            zips: results,
          }),
        );
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
        return asJson(withScope({ state, counties }));
      }
      case "list_metro_areas": {
        const data = await hudGet(`/fmr/listMetroAreas`);
        const metros = (Array.isArray(data) ? data : []).map((m: any) => ({
          cbsa_code: m.cbsa_code,
          area_name: m.area_name,
          category: m.category,
        }));
        return asJson(withScope({ metros }));
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  }

  return server;
}
