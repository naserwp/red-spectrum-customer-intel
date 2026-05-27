const US_STATE_CODES: Record<string, string> = {
  ALABAMA: "AL",
  ALASKA: "AK",
  ARIZONA: "AZ",
  ARKANSAS: "AR",
  CALIFORNIA: "CA",
  COLORADO: "CO",
  CONNECTICUT: "CT",
  DELAWARE: "DE",
  "DISTRICT OF COLUMBIA": "DC",
  FLORIDA: "FL",
  GEORGIA: "GA",
  HAWAII: "HI",
  IDAHO: "ID",
  ILLINOIS: "IL",
  INDIANA: "IN",
  IOWA: "IA",
  KANSAS: "KS",
  KENTUCKY: "KY",
  LOUISIANA: "LA",
  MAINE: "ME",
  MARYLAND: "MD",
  MASSACHUSETTS: "MA",
  MICHIGAN: "MI",
  MINNESOTA: "MN",
  MISSISSIPPI: "MS",
  MISSOURI: "MO",
  MONTANA: "MT",
  NEBRASKA: "NE",
  NEVADA: "NV",
  "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ",
  "NEW MEXICO": "NM",
  "NEW YORK": "NY",
  "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND",
  OHIO: "OH",
  OKLAHOMA: "OK",
  OREGON: "OR",
  PENNSYLVANIA: "PA",
  "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN",
  TEXAS: "TX",
  UTAH: "UT",
  VERMONT: "VT",
  VIRGINIA: "VA",
  WASHINGTON: "WA",
  "WEST VIRGINIA": "WV",
  WISCONSIN: "WI",
  WYOMING: "WY",
};

const STATE_NAMES_BY_CODE = Object.fromEntries(Object.entries(US_STATE_CODES).map(([name, code]) => [code, titleCaseState(name)]));
const STATE_CODES = new Set(Object.values(US_STATE_CODES));
const PLACEHOLDER_COMPANIES = new Set(["unknown", "n/a", "na", "test", "none", "-", "--"]);

export type BusinessNameField = {
  path: string;
  source: string;
  rawValue: string;
  businessName: string;
};

export type CustomerStateField = {
  path: string;
  source: string;
  rawValue: string;
  stateCode: string;
  stateName: string;
};

export type ResolvedBusinessName = {
  businessName: string;
  businessNameSource: string;
  fields: BusinessNameField[];
};

export type ResolvedCustomerState = {
  stateCode: string;
  stateName: string;
  stateSource: string;
  fields: CustomerStateField[];
};

export type StateOption = {
  code: string;
  name: string;
  count: number;
};

function titleCaseState(value: string) {
  return value.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readPath(source: unknown, path: string[]) {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function latestOrders(customer: unknown) {
  return [
    readPath(customer, ["latestWooOrder"]),
    ...(Array.isArray(readPath(customer, ["latestWooOrders"])) ? readPath(customer, ["latestWooOrders"]) as unknown[] : []),
    ...(Array.isArray(readPath(customer, ["wooOrders"])) ? readPath(customer, ["wooOrders"]) as unknown[] : []),
  ].filter(Boolean);
}

function storedOrders(customer: unknown) {
  const orders = readPath(customer, ["orders"]);
  return Array.isArray(orders) ? orders : [];
}

export function normalizeBusinessName(value: unknown) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (PLACEHOLDER_COMPANIES.has(normalized.toLowerCase())) return "";
  return normalized;
}

export function stateNameForCode(code: string) {
  return STATE_NAMES_BY_CODE[code] ?? "";
}

export function normalizeStateCode(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const alpha = raw.replace(/[^a-zA-Z ]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  if (!alpha) return "";
  if (alpha.length === 2 && STATE_CODES.has(alpha)) return alpha;
  return US_STATE_CODES[alpha] ?? "";
}

function businessField(source: string, path: string, value: unknown): BusinessNameField | null {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) return null;
  return { path, source, rawValue, businessName: normalizeBusinessName(rawValue) };
}

function stateField(source: string, path: string, value: unknown): CustomerStateField | null {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) return null;
  const stateCode = normalizeStateCode(rawValue);
  return { path, source, rawValue, stateCode, stateName: stateCode ? stateNameForCode(stateCode) : "" };
}

export function collectBusinessNameFields(customer: unknown): BusinessNameField[] {
  const fields: Array<BusinessNameField | null> = [];
  latestOrders(customer).forEach((order, index) => fields.push(businessField("latest order", `latestWooOrder[${index}].billingCompany`, readPath(order, ["billingCompany"]))));
  storedOrders(customer).forEach((order, index) => fields.push(businessField("orders", `orders[${index}].billingCompany`, readPath(order, ["billingCompany"]))));
  latestOrders(customer).forEach((order, index) => fields.push(businessField("latest order", `latestWooOrder[${index}].billing.company`, readPath(order, ["billing", "company"]))));
  fields.push(businessField("billing", "billingAddress.company", readPath(customer, ["billingAddress", "company"])));
  fields.push(businessField("businessProfile", "businessProfile.businessName", readPath(customer, ["businessProfile", "businessName"])));
  fields.push(businessField("businessProfile", "businessProfile.company", readPath(customer, ["businessProfile", "company"])));
  return fields.filter((field): field is BusinessNameField => Boolean(field));
}

export function collectCustomerStateFields(customer: unknown): CustomerStateField[] {
  const fields: Array<CustomerStateField | null> = [];
  latestOrders(customer).forEach((order, index) => fields.push(stateField("latest order", `latestWooOrder[${index}].billingAddress.state`, readPath(order, ["billingAddress", "state"]))));
  latestOrders(customer).forEach((order, index) => fields.push(stateField("latest order", `latestWooOrder[${index}].billing.state`, readPath(order, ["billing", "state"]))));
  storedOrders(customer).forEach((order, index) => fields.push(stateField("orders", `orders[${index}].billingAddress.state`, readPath(order, ["billingAddress", "state"]))));
  fields.push(stateField("businessProfile", "businessProfile.state", readPath(customer, ["businessProfile", "state"])));
  fields.push(stateField("businessProfile", "businessProfile.stateCode", readPath(customer, ["businessProfile", "stateCode"])));
  return fields.filter((field): field is CustomerStateField => Boolean(field));
}

export function resolveCustomerBusinessName(customer: unknown): ResolvedBusinessName {
  const fields = collectBusinessNameFields(customer);
  const match = fields.find((field) => field.businessName);
  return {
    businessName: match?.businessName ?? "",
    businessNameSource: match?.source ?? "",
    fields,
  };
}

export function resolveCustomerState(customer: unknown): ResolvedCustomerState {
  const fields = collectCustomerStateFields(customer);
  const match = fields.find((field) => field.stateCode);
  return {
    stateCode: match?.stateCode ?? "",
    stateName: match?.stateName ?? "",
    stateSource: match?.source ?? "",
    fields,
  };
}

export function buildStateOptions(rows: Array<{ stateCode?: string; stateName?: string }>): StateOption[] {
  const counts = new Map<string, StateOption>();
  for (const row of rows) {
    if (!row.stateCode) continue;
    const current = counts.get(row.stateCode) ?? {
      code: row.stateCode,
      name: row.stateName || stateNameForCode(row.stateCode),
      count: 0,
    };
    current.count += 1;
    counts.set(row.stateCode, current);
  }
  return Array.from(counts.values()).sort((a, b) => a.code.localeCompare(b.code));
}
