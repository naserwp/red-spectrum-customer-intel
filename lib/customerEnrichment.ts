import {
  normalizeBusinessName,
  normalizeStateCode,
  resolveCustomerBusinessName,
  resolveCustomerState,
  stateNameForCode,
} from "@/lib/customerBusinessResolver";

export type EnrichmentConfidence = "high" | "medium" | "low" | "unresolved";

export type BusinessNameEnrichment = {
  businessName: string;
  businessNameSource: string;
  businessNameConfidence: EnrichmentConfidence;
  enrichmentSource: string;
};

export type StateEnrichment = {
  stateCode: string;
  stateName: string;
  stateSource: string;
  stateConfidence: EnrichmentConfidence;
  enrichmentSource: string;
};

export type CustomerProfileEnrichment = BusinessNameEnrichment & StateEnrichment & {
  resolved: boolean;
};

const COMMON_EMAIL_DOMAINS = new Set([
  "aol",
  "att",
  "comcast",
  "gmail",
  "hotmail",
  "icloud",
  "live",
  "me",
  "msn",
  "outlook",
  "protonmail",
  "sbcglobal",
  "verizon",
  "yahoo",
]);

const DOMAIN_WORDS: Record<string, string> = {
  acct: "Accounting",
  biz: "Business",
  co: "Company",
  corp: "Corp",
  elec: "Electric",
  hvac: "HVAC",
  inc: "Inc",
  llc: "LLC",
  plumb: "Plumbing",
  plumbing: "Plumbing",
  pri: "Plumbing",
  svc: "Services",
  tech: "Tech",
};

const ZIP_PREFIX_STATE: Array<[number, number, string]> = [
  [350, 369, "AL"], [995, 999, "AK"], [850, 865, "AZ"], [716, 729, "AR"], [900, 961, "CA"],
  [800, 816, "CO"], [60, 69, "CT"], [197, 199, "DE"], [320, 349, "FL"], [300, 319, "GA"],
  [967, 968, "HI"], [832, 838, "ID"], [600, 629, "IL"], [460, 479, "IN"], [500, 528, "IA"],
  [660, 679, "KS"], [400, 427, "KY"], [700, 714, "LA"], [39, 49, "ME"], [206, 219, "MD"],
  [10, 27, "MA"], [480, 499, "MI"], [550, 567, "MN"], [386, 397, "MS"], [630, 658, "MO"],
  [590, 599, "MT"], [680, 693, "NE"], [889, 898, "NV"], [30, 38, "NH"], [70, 89, "NJ"],
  [870, 884, "NM"], [100, 149, "NY"], [270, 289, "NC"], [580, 588, "ND"], [430, 459, "OH"],
  [730, 749, "OK"], [970, 979, "OR"], [150, 196, "PA"], [28, 29, "RI"], [290, 299, "SC"],
  [570, 577, "SD"], [370, 385, "TN"], [750, 799, "TX"], [840, 847, "UT"], [50, 59, "VT"],
  [201, 246, "VA"], [980, 994, "WA"], [247, 268, "WV"], [530, 549, "WI"], [820, 831, "WY"],
];

function readPath(source: unknown, path: string[]) {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function cleanLegalSuffixes(value: string) {
  const suffixes = "(llc|l\\.l\\.c\\.|inc|inc\\.|incorporated|corp|corp\\.|corporation|co|co\\.|company|ltd|ltd\\.)";
  let normalized = value.replace(/\s+/g, " ").trim();
  normalized = normalized.replace(new RegExp(`(?:\\s+${suffixes}){2,}$`, "i"), (match) => {
    const first = match.trim().split(/\s+/)[0];
    return ` ${first}`;
  });
  return normalized;
}

function titleCaseBusiness(value: string) {
  return value.split(" ").map((word) => {
    const upper = word.toUpperCase().replace(/\./g, "");
    if (["DBA", "HVAC", "LLC", "INC", "LP", "PC"].includes(upper)) return upper === "INC" ? "Inc" : upper;
    return word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word;
  }).join(" ");
}

export function normalizeEnrichedBusinessName(value: unknown) {
  const normalized = normalizeBusinessName(value);
  if (!normalized) return "";
  return titleCaseBusiness(cleanLegalSuffixes(normalized));
}

function emailDomain(customer: unknown) {
  const email = String(readPath(customer, ["email"]) || readPath(customer, ["normalizedEmail"]) || readPath(customer, ["businessProfile", "email"]) || "").trim().toLowerCase();
  const domain = email.includes("@") ? email.split("@").pop() || "" : "";
  return domain.split(".")[0] || "";
}

function domainFromUrl(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  const withoutProtocol = raw.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return withoutProtocol.split(/[/?#]/)[0]?.split(".")[0] || "";
}

function wordsFromDomain(domain: string) {
  if (!domain || COMMON_EMAIL_DOMAINS.has(domain)) return "";
  const spaced = domain
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = spaced.includes(" ") ? spaced.split(/\s+/) : spaced.match(/[a-z]+|[0-9]+/g) ?? [];
  const expanded = tokens.length > 1 ? tokens : expandCompactDomain(spaced);
  return expanded.map((word) => DOMAIN_WORDS[word] ?? word).join(" ");
}

function expandCompactDomain(domain: string) {
  if (!domain) return [];
  let value = domain;
  const words: string[] = [];
  for (const known of Object.keys(DOMAIN_WORDS).sort((a, b) => b.length - a.length)) {
    if (value.endsWith(known) && value.length > known.length + 2) {
      words.unshift(DOMAIN_WORDS[known]);
      value = value.slice(0, -known.length);
      break;
    }
  }
  const compact = value
    .replace(/^thumbsu$/i, "thumbs up")
    .replace(/thumbs?up/i, "thumbs up")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  words.unshift(...compact.split(/\s+/).filter(Boolean));
  return words;
}

function businessFromDomain(customer: unknown) {
  const candidates = [
    domainFromUrl(readPath(customer, ["businessProfile", "website"])),
    domainFromUrl(readPath(customer, ["publicEnrichment", "websiteDomain"])),
    domainFromUrl(readPath(customer, ["publicEnrichment", "publicBusinessWebsite"])),
    emailDomain(customer),
  ];
  for (const candidate of candidates) {
    const businessName = normalizeEnrichedBusinessName(wordsFromDomain(candidate));
    if (businessName) return businessName;
  }
  return "";
}

function factiivBusinessName(customer: unknown) {
  return normalizeEnrichedBusinessName(
    readPath(customer, ["factiivProfile", "matchedBusinessName"])
      || readPath(customer, ["factiivProfile", "businessName"])
      || readPath(customer, ["factiivProfile", "company"])
  );
}

function factiivState(customer: unknown) {
  return normalizeStateCode(
    readPath(customer, ["factiivProfile", "state"])
      || readPath(customer, ["factiivProfile", "businessState"])
      || readPath(customer, ["factiivProfile", "stateCode"])
  );
}

function zipState(customer: unknown) {
  const zip = String(
    readPath(customer, ["businessProfile", "zip"])
      || readPath(customer, ["businessProfile", "postcode"])
      || readPath(customer, ["billingAddress", "postcode"])
      || readPath(customer, ["address", "postcode"])
      || ""
  ).trim();
  const prefix = Number(zip.slice(0, 3));
  if (!Number.isFinite(prefix)) return "";
  return ZIP_PREFIX_STATE.find(([start, end]) => prefix >= start && prefix <= end)?.[2] ?? "";
}

export function enrichBusinessName(customer: unknown): BusinessNameEnrichment {
  const direct = resolveCustomerBusinessName(customer);
  if (direct.businessName) {
    return {
      businessName: normalizeEnrichedBusinessName(direct.businessName),
      businessNameSource: direct.businessNameSource,
      businessNameConfidence: direct.businessNameSource.includes("latest") || direct.businessNameSource === "orders" ? "high" : "medium",
      enrichmentSource: direct.businessNameSource,
    };
  }

  const factiiv = factiivBusinessName(customer);
  if (factiiv) return { businessName: factiiv, businessNameSource: "factiv", businessNameConfidence: "medium", enrichmentSource: "factiv" };

  const domainName = businessFromDomain(customer);
  if (domainName) return { businessName: domainName, businessNameSource: "domain", businessNameConfidence: "low", enrichmentSource: "domain" };

  return { businessName: "", businessNameSource: "", businessNameConfidence: "unresolved", enrichmentSource: "unresolved" };
}

export function enrichState(customer: unknown): StateEnrichment {
  const direct = resolveCustomerState(customer);
  if (direct.stateCode) {
    return {
      stateCode: direct.stateCode,
      stateName: direct.stateName,
      stateSource: direct.stateSource,
      stateConfidence: direct.stateSource.includes("latest") || direct.stateSource === "orders" ? "high" : "medium",
      enrichmentSource: direct.stateSource,
    };
  }

  const factiiv = factiivState(customer);
  if (factiiv) return { stateCode: factiiv, stateName: stateNameForCode(factiiv), stateSource: "factiv", stateConfidence: "medium", enrichmentSource: "factiv" };

  const address = normalizeStateCode(readPath(customer, ["businessProfile", "address", "state"]) || readPath(customer, ["businessProfile", "shippingState"]));
  if (address) return { stateCode: address, stateName: stateNameForCode(address), stateSource: "business address", stateConfidence: "medium", enrichmentSource: "business address" };

  const zip = zipState(customer);
  if (zip) return { stateCode: zip, stateName: stateNameForCode(zip), stateSource: "zip", stateConfidence: "low", enrichmentSource: "zip" };

  return { stateCode: "", stateName: "", stateSource: "", stateConfidence: "unresolved", enrichmentSource: "unresolved" };
}

export function enrichCustomerProfile(customer: unknown): CustomerProfileEnrichment {
  const business = enrichBusinessName(customer);
  const state = enrichState(customer);
  return {
    ...business,
    ...state,
    enrichmentSource: [business.enrichmentSource, state.enrichmentSource].filter((source) => source && source !== "unresolved").join(", ") || "unresolved",
    resolved: Boolean(business.businessName || state.stateCode),
  };
}
