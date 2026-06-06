import { normalizeStateCode } from "@/lib/customerBusinessResolver";
import { resolveFactiivScore } from "@/lib/factivScore";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument, type CustomerFactiivProfile } from "@/models/Customer";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

export type FactiivCoverageCandidate = {
  customer: {
    customerId: string;
    name: string;
    email: string;
    businessName: string;
    phone: string;
    ein: string;
    city: string;
    state: string;
  };
  candidate: {
    profileId: string;
    businessName: string;
    email: string;
    ownerName: string;
    phone: string;
    city: string;
    state: string;
    sourceCustomerId: string;
    sourceCustomerEmail: string;
    factiivScore: number | "Missing";
  };
  confidence: number;
  confidenceBand: "high" | "medium" | "low";
  matchReasons: string[];
};

type Identity = {
  customerId: string;
  name: string;
  email: string;
  businessName: string;
  phone: string;
  ein: string;
  city: string;
  state: string;
  normalizedBusiness: string;
  normalizedNameTokens: string[];
  phoneTail: string;
};

type ProfileIdentity = Identity & {
  profileId: string;
  sourceCustomerId: string;
  sourceCustomerEmail: string;
  factiivScore: number | "Missing";
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEmail(value: unknown) {
  return clean(value).toLowerCase();
}

function normalizePhone(value: unknown) {
  return clean(value).replace(/\D/g, "");
}

function normalizeEin(value: unknown) {
  return clean(value).replace(/\D/g, "");
}

function normalizeBusiness(value: unknown) {
  return clean(value)
    .toLowerCase()
    .replace(/\b(llc|l\.l\.c\.|inc|inc\.|corp|corporation|co|company|ltd|limited|pllc)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(value: unknown) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function rawSummaryValue(rawSummary: unknown, keys: string[]) {
  const raw = clean(rawSummary);
  if (!raw) return "";
  const parts = raw.split("|").map((part) => part.trim());
  for (const part of parts) {
    const index = part.indexOf(":");
    if (index < 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    if (keys.includes(key)) return part.slice(index + 1).trim();
  }
  return "";
}

function customerBusinessName(customer: LeanCustomer) {
  return clean(customer.businessProfile?.businessName || customer.businessProfile?.company || customer.creditProfile?.company);
}

function customerCity(customer: LeanCustomer) {
  return clean(customer.businessProfile?.city || customer.businessProfile?.shippingCity);
}

function customerState(customer: LeanCustomer) {
  return normalizeStateCode(customer.businessProfile?.stateCode || customer.businessProfile?.state || customer.businessProfile?.shippingState) || clean(customer.businessProfile?.stateCode || customer.businessProfile?.state);
}

function customerIdentity(customer: LeanCustomer): Identity {
  const phone = normalizePhone(customer.phone || customer.businessProfile?.phone || customer.creditProfile?.phone);
  const businessName = customerBusinessName(customer);
  const name = clean(customer.name);
  return {
    customerId: String(customer._id),
    name,
    email: normalizeEmail(customer.normalizedEmail || customer.email),
    businessName,
    phone,
    ein: normalizeEin(customer.businessProfile?.ein || customer.creditProfile?.ein),
    city: customerCity(customer),
    state: customerState(customer),
    normalizedBusiness: normalizeBusiness(businessName),
    normalizedNameTokens: nameTokens(name),
    phoneTail: phone.slice(-7),
  };
}

function profileIdentity(customer: LeanCustomer): ProfileIdentity | null {
  const profile = (customer.factiivProfile ?? {}) as Partial<CustomerFactiivProfile>;
  const score = resolveFactiivScore(profile);
  const profileId = clean(profile.factiivProfileId || profile.profileId);
  if (!profileId && !profile.factiivMatched && score.exportValue === "Missing") return null;
  const raw = profile.rawSummary;
  const phone = normalizePhone(rawSummaryValue(raw, ["phonenumber", "phone", "telephone"]) || customer.phone || customer.businessProfile?.phone);
  const businessName = clean(profile.matchedBusinessName || rawSummaryValue(raw, ["businessname", "company"]) || customerBusinessName(customer));
  const ownerName = clean(profile.matchedUsername || rawSummaryValue(raw, ["ownername", "username"]) || customer.name);
  const email = normalizeEmail(profile.matchedEmail || rawSummaryValue(raw, ["email"]) || customer.email);
  const state = normalizeStateCode(rawSummaryValue(raw, ["state", "statecode"]) || customerState(customer)) || clean(rawSummaryValue(raw, ["state", "statecode"]) || customerState(customer));
  return {
    customerId: String(customer._id),
    sourceCustomerId: String(customer._id),
    sourceCustomerEmail: normalizeEmail(customer.email),
    profileId,
    name: ownerName,
    email,
    businessName,
    phone,
    ein: normalizeEin(rawSummaryValue(raw, ["ein", "taxid", "tax_id"]) || customer.businessProfile?.ein || customer.creditProfile?.ein),
    city: clean(rawSummaryValue(raw, ["city"]) || customerCity(customer)),
    state,
    normalizedBusiness: normalizeBusiness(businessName),
    normalizedNameTokens: nameTokens(ownerName),
    phoneTail: phone.slice(-7),
    factiivScore: score.exportValue,
  };
}

function overlapCount(a: string[], b: string[]) {
  const bSet = new Set(b);
  return a.filter((token) => bSet.has(token)).length;
}

function scoreCandidate(customer: Identity, profile: ProfileIdentity) {
  let score = 0;
  const reasons: string[] = [];

  if (customer.ein && profile.ein && customer.ein === profile.ein) {
    score += 90;
    reasons.push("ein_exact");
  }
  if (customer.email && profile.email && customer.email === profile.email) {
    score += 90;
    reasons.push("email_exact");
  }
  if (customer.normalizedBusiness && profile.normalizedBusiness) {
    if (customer.normalizedBusiness === profile.normalizedBusiness) {
      score += 50;
      reasons.push("business_exact");
    } else if (customer.normalizedBusiness.includes(profile.normalizedBusiness) || profile.normalizedBusiness.includes(customer.normalizedBusiness)) {
      score += 35;
      reasons.push("business_partial");
    }
  }
  const ownerOverlap = overlapCount(customer.normalizedNameTokens, profile.normalizedNameTokens);
  if (ownerOverlap >= 2) {
    score += 20;
    reasons.push("owner_name_overlap");
  } else if (ownerOverlap === 1) {
    score += 10;
    reasons.push("owner_name_partial");
  }
  if (customer.phoneTail.length >= 7 && profile.phoneTail.length >= 7 && customer.phoneTail === profile.phoneTail) {
    score += 25;
    reasons.push("phone_tail_match");
  }
  if (customer.state && profile.state && customer.state === profile.state) {
    score += 8;
    reasons.push("state_overlap");
  }
  if (customer.city && profile.city && customer.city.toLowerCase() === profile.city.toLowerCase()) {
    score += 7;
    reasons.push("city_overlap");
  }

  return { confidence: Math.min(100, score), matchReasons: reasons };
}

function band(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 90) return "high";
  if (confidence >= 70) return "medium";
  return "low";
}

export async function buildFactiivCoverageCandidates(limit = 100) {
  await connectToDatabase();
  const customers = await Customer.find({}, {
    name: 1,
    email: 1,
    normalizedEmail: 1,
    phone: 1,
    businessProfile: 1,
    creditProfile: 1,
    factiivProfile: 1,
  }).lean<LeanCustomer[]>();

  const profiles = customers.map(profileIdentity).filter((profile): profile is ProfileIdentity => Boolean(profile));
  const profileIds = new Set(profiles.map((profile) => profile.sourceCustomerId));
  const missingCustomers = customers.filter((customer) => {
    const score = resolveFactiivScore(customer.factiivProfile);
    return !profileIds.has(String(customer._id)) && score.exportValue === "Missing";
  });

  const candidates: FactiivCoverageCandidate[] = [];
  for (const customer of missingCustomers) {
    const identity = customerIdentity(customer);
    let best: FactiivCoverageCandidate | null = null;
    for (const profile of profiles) {
      const scored = scoreCandidate(identity, profile);
      if (scored.confidence <= 0) continue;
      const candidate: FactiivCoverageCandidate = {
        customer: {
          customerId: identity.customerId,
          name: identity.name,
          email: identity.email,
          businessName: identity.businessName,
          phone: identity.phone,
          ein: identity.ein,
          city: identity.city,
          state: identity.state,
        },
        candidate: {
          profileId: profile.profileId,
          businessName: profile.businessName,
          email: profile.email,
          ownerName: profile.name,
          phone: profile.phone,
          city: profile.city,
          state: profile.state,
          sourceCustomerId: profile.sourceCustomerId,
          sourceCustomerEmail: profile.sourceCustomerEmail,
          factiivScore: profile.factiivScore,
        },
        confidence: scored.confidence,
        confidenceBand: band(scored.confidence),
        matchReasons: scored.matchReasons,
      };
      if (!best || candidate.confidence > best.confidence) best = candidate;
    }
    if (best) candidates.push(best);
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.customer.email.localeCompare(b.customer.email));
  const highConfidenceCandidates = candidates.filter((candidate) => candidate.confidence >= 90).length;
  const mediumConfidenceCandidates = candidates.filter((candidate) => candidate.confidence >= 70 && candidate.confidence < 90).length;
  const lowConfidenceCandidates = candidates.filter((candidate) => candidate.confidence > 0 && candidate.confidence < 70).length;

  return {
    totalCustomers: customers.length,
    customersWithFactiiv: customers.length - missingCustomers.length,
    customersWithoutFactiiv: missingCustomers.length,
    highConfidenceCandidates,
    mediumConfidenceCandidates,
    lowConfidenceCandidates,
    estimatedRecoverableProfiles: highConfidenceCandidates + mediumConfidenceCandidates,
    storedFactiivProfileCorpus: profiles.length,
    candidates: candidates.slice(0, Math.max(1, Math.min(500, limit))),
  };
}
