const PLACEHOLDER_COMPANIES = new Set(["unknown", "n/a", "na", "test", "none", "-", "--"]);

export type BusinessNameField = {
  path: string;
  source: string;
  rawValue: string;
  businessName: string;
};

export type ResolvedBusinessName = {
  businessName: string;
  businessNameSource: string;
  fields: BusinessNameField[];
};

export function normalizeBusinessName(value: unknown) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (PLACEHOLDER_COMPANIES.has(normalized.toLowerCase())) return "";
  return normalized;
}

function readPath(source: unknown, path: string[]) {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function addField(fields: BusinessNameField[], source: string, path: string, value: unknown) {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) return;
  fields.push({
    path,
    source,
    rawValue,
    businessName: normalizeBusinessName(rawValue),
  });
}

export function collectBusinessNameFields(customer: unknown, extraOrders: unknown[] = []) {
  const fields: BusinessNameField[] = [];
  const candidates: Array<{ source: string; path: string[] }> = [
    { source: "businessProfile", path: ["businessProfile", "businessName"] },
    { source: "businessProfile", path: ["businessProfile", "company"] },
    { source: "profile", path: ["profile", "company"] },
    { source: "customer", path: ["company"] },
    { source: "billing", path: ["billing", "company"] },
    { source: "billing", path: ["billingCompany"] },
    { source: "billing", path: ["billingAddress", "company"] },
  ];
  for (const candidate of candidates) {
    addField(fields, candidate.source, candidate.path.join("."), readPath(customer, candidate.path));
  }

  const storedOrders = readPath(customer, ["orders"]);
  const storedOrderCount = Array.isArray(storedOrders) ? storedOrders.length : 0;
  const orders = [
    ...(Array.isArray(storedOrders) ? storedOrders : []),
    ...extraOrders,
  ];
  orders.forEach((order, index) => {
    const prefix = index < storedOrderCount ? `orders[${index}]` : `latestWooOrder[${index - storedOrderCount}]`;
    addField(fields, "latest order", `${prefix}.billingCompany`, readPath(order, ["billingCompany"]));
    addField(fields, "latest order", `${prefix}.billing.company`, readPath(order, ["billing", "company"]));
    addField(fields, "latest order", `${prefix}.billingAddress.company`, readPath(order, ["billingAddress", "company"]));
  });

  return fields;
}

export function resolveBusinessName(customer: unknown, extraOrders: unknown[] = []): ResolvedBusinessName {
  const fields = collectBusinessNameFields(customer, extraOrders);
  const match = fields.find((field) => field.businessName);
  return {
    businessName: match?.businessName ?? "",
    businessNameSource: match?.source ?? "",
    fields,
  };
}
