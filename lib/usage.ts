/** Domain: quota report. Owns: normalization, parsing and selection. Excludes: provider I/O and display. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
const SECOND_MS = 1000;
const CODEX_USAGE_LIMIT_ID = "codex";
type PiModel = NonNullable<ExtensionContext["model"]>;
export type CodexUsageModel = Pick<PiModel, "id" | "name" | "provider">;
export const OPENAI_USAGE_PROVIDERS = ["openai-codex", "openai"] as const;
export function isOpenAICodexModel(model: Pick<PiModel, "provider"> | undefined): boolean {
  return OPENAI_USAGE_PROVIDERS.some((provider) => model?.provider === provider);
}
/** Explicit display-only adapters. Adding a proxy never grants it auth or Fast support. */
const CODEX_USAGE_PROXY_PREFIXES: Readonly<Record<string, string>> = { magpie: "codex/" };

/** Proxy namespaces identify Codex models, not their routed subscription accounts. */
export function isCodexProxyModel(model: Pick<PiModel, "provider" | "id"> | undefined): boolean {
  if (!model || !Object.hasOwn(CODEX_USAGE_PROXY_PREFIXES, model.provider)) return false;
  const prefix = CODEX_USAGE_PROXY_PREFIXES[model.provider]!;
  return model.id.startsWith(prefix) && model.id.length > prefix.length;
}
/** Display eligibility is deliberately broader than native auth and Fast eligibility. */
export function isCodexUsageModel(model: Pick<PiModel, "provider" | "id"> | undefined): boolean {
  return isOpenAICodexModel(model) || isCodexProxyModel(model);
}
export type UsageSource = "pi-auth" | "codex-app-server";
export type UsageQueryError = { source: UsageSource; message: string; cause?: unknown };
export type CodexUsageReport = {
  snapshots: NormalizedRateLimitSnapshot[];
  credits?: NormalizedCreditUsage;
};

export type NormalizedCreditUsage = {
  remainingPercent: number;
  resetAt?: number;
};

export type NormalizedRateLimitSnapshot = {
  limitId: string;
  primary?: NormalizedRateLimitWindow;
  secondary?: NormalizedRateLimitWindow;
};

export type NormalizedRateLimitWindow = {
  usedPercent: number;
  resetAt?: number;
};

export type RateLimitStatusPayload = {
  rate_limit?: unknown;
  additional_rate_limits?: unknown;
  credits?: unknown;
  spend_control?: unknown;
};

type BackendRateLimitDetails = {
  primary_window?: unknown;
  secondary_window?: unknown;
};

type BackendWindowSnapshot = {
  used_percent?: unknown;
  reset_at?: unknown;
  resets_at?: unknown;
  reset_time?: unknown;
  end_time?: unknown;
  ends_at?: unknown;
  expires_at?: unknown;
  reset_after_seconds?: unknown;
};

export type AppServerRateLimitResponse = {
  rateLimits?: unknown;
};

type AppServerRateLimitSnapshot = {
  limitId?: unknown;
  primary?: unknown;
  secondary?: unknown;
};

type AppServerWindowSnapshot = {
  usedPercent?: unknown;
  resetAt?: unknown;
  resetsAt?: unknown;
  resetTime?: unknown;
  endTime?: unknown;
  endsAt?: unknown;
  expiresAt?: unknown;
  resetAfterSeconds?: unknown;
};


export function normalizeBackendPayload(
  payload: RateLimitStatusPayload,
  _capturedAt: number,
  _source: UsageSource,
): CodexUsageReport {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  const primarySnapshot = normalizeBackendSnapshot(
    CODEX_USAGE_LIMIT_ID,
    payload.rate_limit,
    _capturedAt,
  );
  if (primarySnapshot) snapshots.push(primarySnapshot);

  const credits = normalizeBackendCredits(payload, _capturedAt);
  if (snapshots.length === 0 && !credits) {
    throw new Error(
      "Codex usage endpoint returned no displayable rate-limit windows or credits.",
    );
  }
  return credits ? { snapshots, credits } : { snapshots };
}

function normalizeBackendCredits(
  payload: RateLimitStatusPayload,
  capturedAt: number,
): NormalizedCreditUsage | undefined {
  const spendControl = payload.spend_control as
    | Record<string, unknown>
    | undefined;
  const individualLimit = spendControl?.individual_limit as
    | Record<string, unknown>
    | undefined;
  const credits = payload.credits as Record<string, unknown> | undefined;
  const limit = asNumber(individualLimit?.limit);
  const used = asNumber(individualLimit?.used);
  const remaining = asNumber(individualLimit?.remaining);
  const resetAt = asResetTime(
    [
      individualLimit?.reset_at,
      individualLimit?.resets_at,
      individualLimit?.reset_time,
      spendControl?.reset_at,
      spendControl?.resets_at,
      credits?.reset_at,
      credits?.resets_at,
    ],
    individualLimit?.reset_after_seconds ?? spendControl?.reset_after_seconds,
    capturedAt,
  );
  if (
    limit === undefined ||
    used === undefined ||
    remaining === undefined ||
    limit <= 0
  )
    return undefined;
  const remainingPercent = Math.min(
    100,
    Math.max(0, (remaining / limit) * 100),
  );
  return resetAt === undefined
    ? { remainingPercent }
    : { remainingPercent, resetAt };
}

function normalizeBackendSnapshot(
  limitId: string,
  rateLimit: unknown,
  capturedAt: number,
): NormalizedRateLimitSnapshot | undefined {
  if (rateLimit === null || rateLimit === undefined) return undefined;
  const details = assertObject(
    rateLimit,
    "rate limit",
  ) as BackendRateLimitDetails;
  const primary = normalizeBackendWindow(details.primary_window, capturedAt);
  const secondary = normalizeBackendWindow(
    details.secondary_window,
    capturedAt,
  );
  if (!primary && !secondary) return undefined;
  return { limitId, primary, secondary };
}

function normalizeBackendWindow(
  value: unknown,
  capturedAt: number,
): NormalizedRateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(
    value,
    "rate-limit window",
  ) as BackendWindowSnapshot;
  const usedPercent = asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const resetAt = asResetTime(
    [
      window.reset_at,
      window.resets_at,
      window.reset_time,
      window.end_time,
      window.ends_at,
      window.expires_at,
    ],
    window.reset_after_seconds,
    capturedAt,
  );
  return resetAt === undefined ? { usedPercent } : { usedPercent, resetAt };
}

export function normalizeAppServerResponse(
  response: AppServerRateLimitResponse,
  _capturedAt: number,
): CodexUsageReport {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  const addSnapshot = (raw: unknown, fallbackId: string) => {
    const snapshot = normalizeAppServerSnapshot(raw, fallbackId, _capturedAt);
    if (!snapshot) return;
    const existingIndex = snapshots.findIndex(
      (item) => item.limitId === snapshot.limitId,
    );
    if (existingIndex >= 0)
      snapshots[existingIndex] = mergeSnapshot(
        snapshots[existingIndex],
        snapshot,
      );
    else snapshots.push(snapshot);
  };

  if (Array.isArray(response.rateLimits)) {
    for (const item of response.rateLimits) addSnapshot(item, "codex");
  } else {
    addSnapshot(response.rateLimits, "codex");
  }
  if (snapshots.length === 0) {
    throw new Error(
      "codex app-server returned no displayable rate-limit windows.",
    );
  }

  return { snapshots };
}

function normalizeAppServerSnapshot(
  raw: unknown,
  fallbackId: string,
  capturedAt: number,
): NormalizedRateLimitSnapshot | undefined {
  if (raw === null || raw === undefined) return undefined;
  const snapshot = assertObject(
    raw,
    "app-server rate-limit snapshot",
  ) as AppServerRateLimitSnapshot;
  const limitId = asString(snapshot.limitId) ?? fallbackId;
  if (normalizedUsageKey(limitId) !== CODEX_USAGE_LIMIT_ID) return undefined;
  const primary = normalizeAppServerWindow(snapshot.primary, capturedAt);
  const secondary = normalizeAppServerWindow(snapshot.secondary, capturedAt);
  if (!primary && !secondary) return undefined;
  return { limitId, primary, secondary };
}

function normalizeAppServerWindow(
  value: unknown,
  capturedAt: number,
): NormalizedRateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(
    value,
    "app-server rate-limit window",
  ) as AppServerWindowSnapshot;
  const usedPercent = asNumber(window.usedPercent);
  if (usedPercent === undefined) return undefined;
  const resetAt = asResetTime(
    [
      window.resetAt,
      window.resetsAt,
      window.resetTime,
      window.endTime,
      window.endsAt,
      window.expiresAt,
    ],
    window.resetAfterSeconds,
    capturedAt,
  );
  return resetAt === undefined ? { usedPercent } : { usedPercent, resetAt };
}

function mergeSnapshot(
  left: NormalizedRateLimitSnapshot,
  right: NormalizedRateLimitSnapshot,
): NormalizedRateLimitSnapshot {
  return {
    limitId: right.limitId || left.limitId,
    primary: right.primary ?? left.primary,
    secondary: right.secondary ?? left.secondary,
  };
}


export function isUsageUnavailable(errors: UsageQueryError[]): boolean {
  return errors.length > 0 && errors.every(isUnavailableError);
}

function isUnavailableError(error: UsageQueryError): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("no pi openai codex subscription auth") ||
    message.includes("no displayable rate-limit windows") ||
    message.includes("returned no displayable rate-limit windows") ||
    message.includes("returned 401") ||
    message.includes("returned 403") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("subscription") ||
    message.includes("no active plan") ||
    message.includes("plan unavailable") ||
    message.includes("quota unavailable") ||
    message.includes("rate limits unavailable")
  );
}

function normalizedUsageKey(value: string | undefined): string | undefined {
  const key = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || undefined;
}


export function canReuseCachedReport(
  report: CodexUsageReport,
  model: CodexUsageModel | undefined,
): boolean {
  return (
    selectActiveUsageSnapshot(report, model) !== undefined ||
    report.credits !== undefined
  );
}

export function isFullyAvailableReport(
  report: CodexUsageReport,
  model?: CodexUsageModel,
): boolean {
  const snapshot = selectActiveUsageSnapshot(report, model);
  const windows = [snapshot?.primary, snapshot?.secondary].filter(
    (window): window is NormalizedRateLimitWindow => window !== undefined,
  );
  return (
    windows.length > 0 &&
    windows.every((window) => clampPercent(window.usedPercent) === 0)
  );
}


export function selectActiveUsageSnapshot(
  report: CodexUsageReport,
  _model: CodexUsageModel | undefined,
): NormalizedRateLimitSnapshot | undefined {
  return selectUsageSnapshot(report, CODEX_USAGE_LIMIT_ID);
}

export function selectUsageSnapshot(
  report: CodexUsageReport,
  limitId: string,
): NormalizedRateLimitSnapshot | undefined {
  const normalizedLimitId = normalizedUsageKey(limitId);
  return report.snapshots.find(
    (snapshot) => normalizedUsageKey(snapshot.limitId) === normalizedLimitId,
  );
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}


export function parseJsonObject(
  text: string,
  description: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${description} was not valid JSON: ${errorMessage(error)}`,
    );
  }
  return assertObject(parsed, description);
}

export function assertObject(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} was not an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asResetTime(
  absoluteValues: unknown[],
  relativeSeconds: unknown,
  capturedAt: number,
): number | undefined {
  for (const value of absoluteValues) {
    const timestamp = asTimestampMs(value);
    if (timestamp !== undefined) return timestamp;
  }
  const seconds = asNumber(relativeSeconds);
  if (seconds === undefined || seconds < 0) return undefined;
  return capturedAt + seconds * SECOND_MS;
}

function asTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return undefined;
    return value < 10_000_000_000 ? value * SECOND_MS : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return asTimestampMs(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}


export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
