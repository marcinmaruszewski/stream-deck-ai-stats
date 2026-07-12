const PACE_THRESHOLDS = {
  atRisk: 0.9,
  likelyToExhaust: 1,
};

export function normalizeObservation(input, { now, freshnessMs }) {
  const observedAt = asDate(input.observedAt);
  const resetAt = asDate(input.resetAt);
  const usageProgress = validProgress(input.usageProgress) ? input.usageProgress : null;
  const durationMs = validDuration(input.durationMs) ? input.durationMs : null;
  const awaitingFreshObservation = input.awaitingFreshObservation === true;
  const quality = observationQuality({ usageProgress, observedAt, resetAt, awaitingFreshObservation, now, freshnessMs });

  return {
    provider: input.provider,
    windowKind: input.windowKind,
    usageProgress,
    resetAt,
    observedAt,
    durationMs,
    ...(awaitingFreshObservation ? { awaitingFreshObservation: true } : {}),
    provenance: input.provenance ?? "provider-reported",
    quality,
    forecast: forecastFor({ usageProgress, resetAt, observedAt, durationMs, quality, now }),
  };
}

export function staleObservation(observation) {
  return { ...observation, quality: "stale", forecast: unknownForecast() };
}

function observationQuality({ usageProgress, observedAt, resetAt, awaitingFreshObservation, now, freshnessMs }) {
  if (usageProgress === null || observedAt === null || resetAt === null) {
    return "incomplete";
  }

  if (awaitingFreshObservation) return "stale";
  return now.getTime() - observedAt.getTime() > freshnessMs ? "stale" : "fresh";
}

function forecastFor({ usageProgress, resetAt, durationMs, quality, now }) {
  if (quality !== "fresh" || resetAt === null || durationMs === null || usageProgress === null) {
    return unknownForecast();
  }

  const elapsedFraction = (now.getTime() - (resetAt.getTime() - durationMs)) / durationMs;
  if (elapsedFraction <= 0 || elapsedFraction > 1) {
    return unknownForecast();
  }

  const projectedUsageProgress = usageProgress / elapsedFraction;
  return {
    paceStatus: paceStatus(projectedUsageProgress),
    paceDelta: round(elapsedFraction - usageProgress),
    projectedUsageProgress: round(projectedUsageProgress),
  };
}

function paceStatus(projectedUsageProgress) {
  if (projectedUsageProgress >= PACE_THRESHOLDS.likelyToExhaust) return "likely-to-exhaust";
  if (projectedUsageProgress >= PACE_THRESHOLDS.atRisk) return "at-risk";
  return "on-track";
}

function unknownForecast() {
  return { paceStatus: "unknown", paceDelta: null, projectedUsageProgress: null };
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function validProgress(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function asDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return null;
}
