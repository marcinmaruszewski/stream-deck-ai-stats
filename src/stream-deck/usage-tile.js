const CIRCUMFERENCE = 2 * Math.PI * 48;

const PACE_COLORS = Object.freeze({
  "on-track": "#4ade80",
  "at-risk": "#f59e0b",
  "likely-to-exhaust": "#fb6b52",
  unknown: "#94a3b8",
});

const PROVIDERS = Object.freeze({
  codex: { label: "Codex", mark: "◌", accent: "#38bdf8" },
  claude: { label: "Claude", mark: "✦", accent: "#fb8b6a" },
});

export function actionBinding(action) {
  const match = /^com\.marcinmaruszewski\.ai-usage\.(codex|claude)\.(short-term|long-term)$/.exec(action ?? "");
  return match ? Object.freeze({ provider: match[1], windowKind: match[2] }) : null;
}

export function renderUsageTile({ provider, windowKind, window, operationalState = "normal", error, now = new Date(), providerMarkUri }) {
  const providerStyle = PROVIDERS[provider] ?? { label: provider || "Provider", mark: "•", accent: "#64748b" };
  const progress = validProgress(window?.usageProgress) ? window.usageProgress : null;
  const paceStatus = window?.forecast?.paceStatus ?? "unknown";
  const paceColor = PACE_COLORS[paceStatus] ?? PACE_COLORS.unknown;
  const dash = progress === null ? 0 : Math.round(progress * CIRCUMFERENCE);
  const percent = progress === null ? "—" : `${Math.round(progress * 100)}%`;
  const reset = resetLabel(window?.resetAt, now);
  const delta = deltaLabel(window?.forecast?.paceDelta);
  const badge = badgeFor({ operationalState, quality: window?.quality, error });
  const windowLabel = windowKind === "short-term" ? "5h" : "7d";
  const statusLabel = badge ? ` ${badge.label}` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144" role="img" aria-label="${escapeXml(`${providerStyle.label} ${windowLabel}: ${percent}${statusLabel}`)}">
  <rect width="144" height="144" rx="12" fill="#101826"/>
  <circle cx="72" cy="76" r="51" fill="${providerStyle.accent}" opacity=".12"/>
  <text x="14" y="20" fill="#e2e8f0" font-family="system-ui, sans-serif" font-size="12" font-weight="700">${escapeXml(providerStyle.label)} ${windowLabel}</text>
  ${badge ? `<circle cx="126" cy="18" r="9" fill="${badge.color}"/>${badge.pulsing ? `<circle cx="126" cy="18" r="9" fill="none" stroke="${badge.color}" stroke-width="2"><animate attributeName="r" values="9;14;9" dur="1.5s" repeatCount="indefinite"/><animate attributeName="opacity" values=".8;0;.8" dur="1.5s" repeatCount="indefinite"/></circle>` : ""}<text x="126" y="22" text-anchor="middle" fill="#fff" font-family="system-ui, sans-serif" font-size="11" font-weight="700">${badge.symbol}</text>` : ""}
  <circle cx="72" cy="76" r="48" fill="none" stroke="#334155" stroke-width="9"/>
  <circle cx="72" cy="76" r="48" fill="none" stroke="${paceColor}" stroke-width="9" stroke-linecap="round" transform="rotate(-90 72 76)" stroke-dasharray="${dash} ${Math.ceil(CIRCUMFERENCE - dash)}"/>
  ${providerMarkUri ? `<image href="${escapeXml(providerMarkUri)}" x="53" y="48" width="38" height="38" opacity=".25" preserveAspectRatio="xMidYMid meet"/>` : `<text x="72" y="65" text-anchor="middle" fill="${providerStyle.accent}" opacity=".55" font-family="system-ui, sans-serif" font-size="26">${providerStyle.mark}</text>`}
  <text x="72" y="87" text-anchor="middle" fill="${paceColor}" font-family="system-ui, sans-serif" font-size="25" font-weight="800">${percent}</text>
  <text x="14" y="132" fill="#cbd5e1" font-family="system-ui, sans-serif" font-size="11">${escapeXml(reset)}</text>
  <text x="130" y="132" text-anchor="end" fill="${paceColor}" font-family="system-ui, sans-serif" font-size="11" font-weight="700">${escapeXml(delta)}</text>
</svg>`;
}

export function usageTileDataUrl(input) {
  return `data:image/svg+xml;base64,${Buffer.from(renderUsageTile(input)).toString("base64")}`;
}

function badgeFor({ operationalState, quality, error }) {
  if (operationalState === "error" || error) return { color: "#ef4444", symbol: "!", label: "error" };
  if (operationalState === "window-keeping") return { color: "#38bdf8", symbol: "↻", label: "keeping window active", pulsing: true };
  if (quality === "stale" || quality === "incomplete" || quality === "unknown") return { color: "#f59e0b", symbol: "◷", label: "data is stale" };
  return null;
}

function resetLabel(resetAt, now) {
  const reset = asDate(resetAt);
  if (!reset) return "↻ unavailable";
  const remaining = Math.max(0, reset.getTime() - asDate(now).getTime());
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return hours >= 24 ? `↻ ${Math.floor(hours / 24)}d` : `↻ ${hours}h ${minutes}m`;
}

function deltaLabel(delta) {
  if (!Number.isFinite(delta)) return "Δ —";
  const points = Math.round(delta * 100);
  return `Δ ${points >= 0 ? "+" : "−"}${Math.abs(points)}pp`;
}

function validProgress(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]);
}
