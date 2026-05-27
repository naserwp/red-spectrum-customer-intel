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

const US_STATE_ABBREVIATIONS = new Set(Object.values(US_STATE_CODES));

export function normalizeStateCode(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const alpha = raw.replace(/[^a-zA-Z ]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  if (!alpha) return "";
  if (alpha.length === 2 && US_STATE_ABBREVIATIONS.has(alpha)) return alpha;
  return US_STATE_CODES[alpha] ?? "";
}

function readPath(source: unknown, path: string[]) {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function resolveCustomerStateCode(customer: unknown) {
  const candidates = [
    ["businessProfile", "state"],
    ["billingState"],
    ["shippingState"],
    ["address", "state"],
    ["billing", "state"],
    ["shipping", "state"],
    ["businessProfile", "shippingState"],
  ];
  for (const path of candidates) {
    const code = normalizeStateCode(readPath(customer, path));
    if (code) return code;
  }

  const orders = readPath(customer, ["orders"]);
  if (Array.isArray(orders)) {
    for (const order of orders) {
      const code = normalizeStateCode(readPath(order, ["billingAddress", "state"]))
        || normalizeStateCode(readPath(order, ["billing", "state"]))
        || normalizeStateCode(readPath(order, ["shippingAddress", "state"]))
        || normalizeStateCode(readPath(order, ["shipping", "state"]));
      if (code) return code;
    }
  }
  return "";
}

export function uniqueStateCodes(rows: Array<{ stateCode?: string }>) {
  return Array.from(new Set(rows.map((row) => row.stateCode).filter((state): state is string => Boolean(state)))).sort();
}
