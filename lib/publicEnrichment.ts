import type { CustomerBusinessProfile, CustomerDocument, CustomerPublicEnrichment } from "@/models/Customer";

function asText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeDomainFromEmail(email: string) {
  const domain = email.includes("@") ? email.split("@")[1] : "";
  if (!domain || domain.endsWith("gmail.com") || domain.endsWith("yahoo.com") || domain.endsWith("hotmail.com") || domain.endsWith("outlook.com")) return "";
  return domain.toLowerCase();
}

function encodeQuery(value: string) {
  return encodeURIComponent(value.trim());
}

function inferIndustry(profile: Partial<CustomerBusinessProfile>, customer: Partial<CustomerDocument>) {
  return profile.industry
    || profile.industryClassification
    || profile.businessType
    || (profile.company && /truck|freight|transport|logistics/i.test(profile.company) ? "Transportation" : "")
    || (customer.paidProducts?.join(" ").match(/builder|business|website/i) ? "Professional Services" : "")
    || "";
}

function sourceList(values: Array<[string, string]>) {
  return values.filter(([, value]) => Boolean(value)).map(([label]) => label);
}

export function buildPublicEnrichment(customer: Partial<CustomerDocument>): CustomerPublicEnrichment {
  const profile: Partial<CustomerBusinessProfile> = customer.businessProfile ?? {};
  const company = asText(profile.company);
  const email = asText(customer.normalizedEmail || customer.email || profile.email);
  const website = asText(profile.website);
  const websiteDomain = website
    ? website.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase()
    : normalizeDomainFromEmail(email);
  const businessQuery = company || asText(customer.name);
  const linkedInCompanyUrl = businessQuery ? `https://www.linkedin.com/search/results/companies/?keywords=${encodeQuery(businessQuery)}` : "";
  const facebookPageUrl = businessQuery ? `https://www.facebook.com/search/pages/?q=${encodeQuery(businessQuery)}` : "";
  const instagramUrl = businessQuery ? `https://www.instagram.com/explore/tags/${encodeQuery(businessQuery.replace(/\s+/g, ""))}/` : "";
  const twitterUrl = businessQuery ? `https://twitter.com/search?q=${encodeQuery(businessQuery)}` : "";
  const publicBusinessWebsite = website || (websiteDomain ? `https://${websiteDomain}` : "");
  const googleBusinessProfileUrl = businessQuery ? `https://www.google.com/search?q=${encodeQuery(`${businessQuery} business profile`)}` : "";
  const secretaryOfStateUrl = company ? `https://www.google.com/search?q=${encodeQuery(`${company} secretary of state`)}` : "";
  const inferredIndustry = inferIndustry(profile, customer);
  const naicsCode = asText(profile.naicsCode);
  const sicCode = asText(profile.sicCode);
  const enrichmentSources = sourceList([
    ["website_domain", websiteDomain],
    ["public_business_website", publicBusinessWebsite],
    ["linkedin_company", linkedInCompanyUrl],
    ["facebook_page", facebookPageUrl],
    ["instagram", instagramUrl],
    ["twitter", twitterUrl],
    ["google_business", googleBusinessProfileUrl],
    ["secretary_of_state", secretaryOfStateUrl],
  ]);
  const socialProfilesFound = [linkedInCompanyUrl, facebookPageUrl, instagramUrl, twitterUrl].filter(Boolean).length;
  const publicBusinessDataFound = Boolean(publicBusinessWebsite || secretaryOfStateUrl || inferredIndustry || naicsCode || sicCode);

  return {
    websiteDomain,
    linkedInCompanyUrl,
    facebookPageUrl,
    instagramUrl,
    twitterUrl,
    publicBusinessWebsite,
    googleBusinessProfileUrl,
    secretaryOfStateUrl,
    inferredIndustry,
    naicsCode,
    sicCode,
    enrichmentSources,
    socialProfilesFound,
    publicBusinessDataFound,
    confidence: publicBusinessDataFound ? (websiteDomain || publicBusinessWebsite ? "medium" : "low") : "none",
    enrichmentStatus: publicBusinessDataFound ? "generated" : "not_verified",
    lastChecked: new Date().toISOString(),
    lastEnrichmentRun: new Date().toISOString(),
  };
}
