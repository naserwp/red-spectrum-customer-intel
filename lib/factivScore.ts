export type FactiivScoreResolution = {
  factiivProfileFound: boolean;
  factiivProfileId: string;
  scoreFieldFound: string;
  scoreValue: number | null;
  exportValue: number | "Missing";
  failureReason: string;
  rawFactiivPayload: unknown;
  scoreCandidates: Array<{ path: string; value: number }>;
};

const priorityPaths = [
  "score",
  "businessScore",
  "creditScore",
  "report.score",
  "analytics.score",
  "funding.score",
  "factiivScore",
  "factivScore",
  "factiivscore",
  "factivscore",
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asText(value: unknown) {
  return String(value ?? "").trim();
}

function asValidScore(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readPath(source: unknown, path: string) {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

function walkScores(source: unknown, prefix = ""): Array<{ path: string; value: number }> {
  if (!source || typeof source !== "object") return [];
  const rows: Array<{ path: string; value: number }> = [];
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const score = /score/i.test(key) && key.toLowerCase() !== "fundingscore" ? asValidScore(value) : null;
    if (score !== null) rows.push({ path, value: score });
    if (value && typeof value === "object" && !Array.isArray(value)) rows.push(...walkScores(value, path));
  }
  return rows;
}

function rawSummaryScores(rawSummary: unknown) {
  const text = asText(rawSummary);
  if (!text) return [] as Array<{ path: string; value: number }>;
  const rows: Array<{ path: string; value: number }> = [];
  const regex = /([A-Za-z0-9_.-]*score[A-Za-z0-9_.-]*)\s*[:=]\s*"?([0-9]+(?:\.[0-9]+)?)"?/gi;
  for (const match of text.matchAll(regex)) {
    const value = asValidScore(match[2]);
    if (value !== null) rows.push({ path: `rawSummary.${match[1]}`, value });
  }
  return rows;
}

export function resolveFactiivScore(profile: unknown): FactiivScoreResolution {
  const record = asRecord(profile);
  const factiivProfileId = asText(record.factiivProfileId || record.profileId || record.id);
  const hasProfile = Boolean(factiivProfileId || record.factiivMatched || record.rawSummary || record.matchedBusinessName || record.matchedEmail || Object.keys(record).some((key) => key.toLowerCase().includes("score") && asValidScore(record[key]) !== null));
  const candidates = [...walkScores(record), ...rawSummaryScores(record.rawSummary)];
  for (const path of priorityPaths) {
    const score = asValidScore(readPath(record, path));
    if (score !== null) {
      return {
        factiivProfileFound: hasProfile,
        factiivProfileId,
        scoreFieldFound: `customer.factiivProfile.${path}`,
        scoreValue: score,
        exportValue: score,
        failureReason: "",
        rawFactiivPayload: profile ?? null,
        scoreCandidates: candidates,
      };
    }
  }
  const firstNested = candidates[0];
  if (firstNested) {
    return {
      factiivProfileFound: hasProfile,
      factiivProfileId,
      scoreFieldFound: `customer.factiivProfile.${firstNested.path}`,
      scoreValue: firstNested.value,
      exportValue: firstNested.value,
      failureReason: "",
      rawFactiivPayload: profile ?? null,
      scoreCandidates: candidates,
    };
  }
  return {
    factiivProfileFound: hasProfile,
    factiivProfileId,
    scoreFieldFound: "",
    scoreValue: null,
    exportValue: "Missing",
    failureReason: hasProfile ? "Factiiv profile exists but no numeric score field was found." : "No Factiiv profile exists on customer record.",
    rawFactiivPayload: profile ?? null,
    scoreCandidates: candidates,
  };
}
