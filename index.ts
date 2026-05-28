import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 15_000;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DAY_TENTH_MS = 144 * MINUTE_MS;
const REFRESH_INTERVAL_MS = 30 * SECOND_MS;
const REDRAW_BLINK_MS = 150;
const STATUS_KEY = "aa-codex-usage";
const MAX_ERROR_BODY_CHARS = 600;
const STATUS_LABEL_TEXT = "codex";
const DUAL_BAR_WIDTH = 10;
const DUAL_BAR_CHARS = [
  "⠀",
  "▘",
  "▝",
  "▀",
  "▖",
  "▌",
  "▞",
  "▛",
  "▗",
  "▚",
  "▐",
  "▜",
  "▄",
  "▙",
  "▟",
  "█",
];

type UsageSource = "pi-auth" | "codex-app-server";
type TimeoutHandle = ReturnType<typeof setTimeout> & { unref?: () => void };
type PiModel = NonNullable<ExtensionContext["model"]>;
export type CodexUsageModel = Pick<PiModel, "id" | "name" | "provider">;

type QueryUsageOptions = {
  timeoutMs: number;
};

type CachedReport = {
  createdAt: number;
  report: CodexUsageReport;
};

type QueryUsageResult =
  | { ok: true; report: CodexUsageReport }
  | { ok: false; errors: UsageQueryError[] };

export type UsageQueryError = {
  source: UsageSource;
  message: string;
  cause?: unknown;
};

export type CodexUsageReport = {
  snapshots: NormalizedRateLimitSnapshot[];
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

type RateLimitStatusPayload = {
  rate_limit?: unknown;
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

type AppServerRateLimitResponse = {
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

type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown; code?: unknown };
};

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export default function codexUsage(pi: ExtensionAPI) {
  let cache: CachedReport | undefined;
  let failedRefreshes = 0;
  let inFlightUsageQuery: Promise<QueryUsageResult> | undefined;
  let statuslineBlinkTimer: TimeoutHandle | undefined;
  let statuslineClearTimer: TimeoutHandle | undefined;
  let statuslineCountdownTimer: TimeoutHandle | undefined;
  let statuslineRefreshTimer: TimeoutHandle | undefined;
  let statuslineRequestId = 0;

  const clearStatuslineTimers = () => {
    if (statuslineBlinkTimer) clearTimeout(statuslineBlinkTimer);
    if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
    if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
    if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
    statuslineBlinkTimer = undefined;
    statuslineClearTimer = undefined;
    statuslineCountdownTimer = undefined;
    statuslineRefreshTimer = undefined;
  };

  const clearUsageStatusline = (ctx: ExtensionContext) => {
    statuslineRequestId += 1;
    clearStatuslineTimers();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const scheduleTemporaryStatuslineClear = (ctx: ExtensionContext) => {
    if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
    statuslineClearTimer = setTimeout(() => {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      statuslineClearTimer = undefined;
    }, REFRESH_INTERVAL_MS) as TimeoutHandle;
    statuslineClearTimer.unref?.();
  };

  const scheduleStatuslineRefresh = (ctx: ExtensionContext) => {
    if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
    statuslineRefreshTimer = setTimeout(() => {
      void refreshCurrentCodexUsageStatusline(ctx, true);
    }, REFRESH_INTERVAL_MS) as TimeoutHandle;
    statuslineRefreshTimer.unref?.();
  };

  const scheduleStatuslineCountdown = (
    ctx: ExtensionContext,
    report: CodexUsageReport,
    model: CodexUsageModel | undefined,
  ) => {
    if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
    const delayMs = nextResetCountdownDelayMs(report);
    if (delayMs === undefined) {
      statuslineCountdownTimer = undefined;
      return;
    }
    statuslineCountdownTimer = setTimeout(() => {
      if (isOpenAICodexModel(ctx.model)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          formatCodexUsageStatusline(report, ctx, model),
        );
        scheduleStatuslineCountdown(ctx, report, model);
      }
    }, delayMs) as TimeoutHandle;
    statuslineCountdownTimer.unref?.();
  };

  const setUsageStatusline = (
    ctx: ExtensionContext,
    report: CodexUsageReport,
    options: {
      autoRefresh: boolean;
      blink: boolean;
      model: CodexUsageModel | undefined;
    },
  ) => {
    if (statuslineBlinkTimer) clearTimeout(statuslineBlinkTimer);
    if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
    if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
    statuslineBlinkTimer = undefined;
    statuslineClearTimer = undefined;
    statuslineCountdownTimer = undefined;
    const text = formatCodexUsageStatusline(report, ctx, options.model);
    if (options.blink) {
      ctx.ui.setStatus(STATUS_KEY, formatEmptyStatuslineBar(ctx));
      statuslineBlinkTimer = setTimeout(() => {
        ctx.ui.setStatus(STATUS_KEY, text);
        scheduleStatuslineCountdown(ctx, report, options.model);
        statuslineBlinkTimer = undefined;
      }, REDRAW_BLINK_MS) as TimeoutHandle;
      statuslineBlinkTimer.unref?.();
    } else {
      ctx.ui.setStatus(STATUS_KEY, text);
      scheduleStatuslineCountdown(ctx, report, options.model);
    }
    if (options.autoRefresh) scheduleStatuslineRefresh(ctx);
    else scheduleTemporaryStatuslineClear(ctx);
  };

  const queryCurrentUsage = (ctx: ExtensionContext) => {
    if (!inFlightUsageQuery) {
      inFlightUsageQuery = queryUsage(ctx, {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      }).finally(() => {
        inFlightUsageQuery = undefined;
      });
    }
    return inFlightUsageQuery;
  };

  const refreshCurrentCodexUsageStatusline = async (
    ctx: ExtensionContext,
    force: boolean,
    model = ctx.model,
  ) => {
    if (!isOpenAICodexModel(model)) {
      clearUsageStatusline(ctx);
      return;
    }

    if (!cache) ctx.ui.setStatus(STATUS_KEY, formatEmptyStatuslineBar(ctx));
    const requestId = statuslineRequestId + 1;
    statuslineRequestId = requestId;
    const cached =
      cache && Date.now() - cache.createdAt < REFRESH_INTERVAL_MS
        ? cache
        : undefined;
    if (cached && !force) {
      setUsageStatusline(ctx, cached.report, {
        autoRefresh: true,
        blink: false,
        model,
      });
      return;
    }

    const result = await queryCurrentUsage(ctx);
    if (requestId !== statuslineRequestId) return;
    if (!isOpenAICodexModel(ctx.model)) {
      clearUsageStatusline(ctx);
      return;
    }

    if (!result.ok) {
      failedRefreshes += 1;
      if (!cache || failedRefreshes >= 5) {
        ctx.ui.setStatus(
          STATUS_KEY,
          formatStatuslineProblem(ctx, result.errors),
        );
      }
      scheduleStatuslineRefresh(ctx);
      return;
    }

    const previousReport = cache?.report;
    const blink = previousReport
      ? formatReportBar(previousReport) !== formatReportBar(result.report)
      : false;
    failedRefreshes = 0;
    cache = { createdAt: Date.now(), report: result.report };
    setUsageStatusline(ctx, result.report, {
      autoRefresh: true,
      blink,
      model,
    });
  };

  pi.on("session_start", (_event, ctx) => {
    if (isOpenAICodexModel(ctx.model))
      void refreshCurrentCodexUsageStatusline(ctx, false);
    else clearUsageStatusline(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (isOpenAICodexModel(ctx.model))
      void refreshCurrentCodexUsageStatusline(ctx, false);
    else clearUsageStatusline(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    if (isOpenAICodexModel(event.model)) {
      void refreshCurrentCodexUsageStatusline(ctx, false, event.model);
    } else {
      clearUsageStatusline(ctx);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => clearUsageStatusline(ctx));
}

function isOpenAICodexModel(
  model: Pick<PiModel, "provider"> | undefined,
): boolean {
  return model?.provider === CODEX_PROVIDER_ID;
}

async function queryUsage(
  ctx: ExtensionContext,
  options: Pick<QueryUsageOptions, "timeoutMs">,
): Promise<QueryUsageResult> {
  const errors: UsageQueryError[] = [];

  try {
    const report = await queryViaPiAuth(ctx, options.timeoutMs);
    return { ok: true, report };
  } catch (cause) {
    errors.push({ source: "pi-auth", message: errorMessage(cause), cause });
  }

  try {
    const report = await queryViaCodexAppServer(options.timeoutMs);
    return { ok: true, report };
  } catch (cause) {
    errors.push({
      source: "codex-app-server",
      message: errorMessage(cause),
      cause,
    });
  }

  return { ok: false, errors };
}

async function queryViaPiAuth(
  ctx: ExtensionContext,
  timeoutMs: number,
): Promise<CodexUsageReport> {
  const auth = await resolvePiCodexAuth(ctx);
  if (!auth) {
    throw new Error(
      "No Pi OpenAI Codex subscription auth was available. Use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro (Codex).",
    );
  }

  const response = await fetchWithTimeout(
    CODEX_USAGE_URL,
    { headers: auth.headers },
    timeoutMs,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Codex usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text)}`,
    );
  }

  const payload = parseJsonObject(text, "Codex usage endpoint response");
  return normalizeBackendPayload(
    payload as RateLimitStatusPayload,
    Date.now(),
    "pi-auth",
  );
}

async function resolvePiCodexAuth(
  ctx: ExtensionContext,
): Promise<{ headers: Record<string, string> } | undefined> {
  const models = codexAuthCandidateModels(ctx);
  const errors: string[] = [];

  for (const model of models) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      errors.push(auth.error);
      continue;
    }

    const headers = { ...(auth.headers ?? {}) };
    if (!hasHeader(headers, "Authorization") && auth.apiKey) {
      headers.Authorization = `Bearer ${auth.apiKey}`;
    }
    if (!hasHeader(headers, "User-Agent")) {
      headers["User-Agent"] = "pi-codex-usage";
    }
    if (hasHeader(headers, "Authorization")) {
      return { headers };
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  return undefined;
}

function codexAuthCandidateModels(ctx: ExtensionContext): PiModel[] {
  const candidates: PiModel[] = [];
  const seen = new Set<string>();
  const add = (model: PiModel | undefined) => {
    if (!model || model.provider !== CODEX_PROVIDER_ID) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };

  add(ctx.model);
  for (const model of ctx.modelRegistry.getAvailable()) add(model);
  for (const model of ctx.modelRegistry.getAll()) add(model);
  return candidates;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s while fetching Codex usage.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function queryViaCodexAppServer(
  timeoutMs: number,
): Promise<CodexUsageReport> {
  const client = new CodexAppServerClient(timeoutMs);
  try {
    await client.start();
    await client.request("initialize", {
      clientInfo: {
        name: "pi_codex_usage",
        title: "Pi Codex Usage",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    client.notify("initialized");
    const result = await client.request("account/rateLimits/read", undefined);
    return normalizeAppServerResponse(
      assertObject(
        result,
        "account/rateLimits/read result",
      ) as AppServerRateLimitResponse,
      Date.now(),
    );
  } finally {
    client.dispose();
  }
}

class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stderr = "";
  private readonly pending = new Map<number, PendingRpc>();
  private startPromise?: Promise<void>;
  private exitError?: Error;
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;

      const startupTimeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out after ${Math.round(this.timeoutMs / 1000)}s starting codex app-server.`,
          ),
        );
      }, this.timeoutMs);

      child.once("spawn", () => {
        clearTimeout(startupTimeout);
        resolve();
      });

      child.once("error", (error) => {
        clearTimeout(startupTimeout);
        reject(new Error(`Failed to start codex app-server: ${error.message}`));
        this.rejectAll(error);
      });

      child.once("exit", (code, signal) => {
        const suffix = this.stderr
          ? ` stderr: ${redactErrorBody(this.stderr)}`
          : "";
        this.exitError = new Error(
          `codex app-server exited before completing the request (code ${code ?? "unknown"}, signal ${signal ?? "none"}).${suffix}`,
        );
        this.rejectAll(this.exitError);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderr = truncateEnd(this.stderr + chunk, MAX_ERROR_BODY_CHARS);
      });

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => this.handleLine(line));
    });

    return this.startPromise;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) {
      throw new Error("codex app-server is not running.");
    }
    if (this.exitError) throw this.exitError;

    const id = this.nextId++;
    const payload =
      params === undefined ? { method, id } : { method, id, params };
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for ${method}.`,
          ),
        );
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  notify(method: string): void {
    const child = this.child;
    if (!child?.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  dispose(): void {
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`codex app-server request ${id} cancelled.`));
    }
    this.pending.clear();

    const child = this.child;
    if (!child) return;
    child.stdin.end();
    if (!child.killed) child.kill();
    this.child = undefined;
  }

  private handleLine(line: string): void {
    let parsed: RpcResponse;
    try {
      parsed = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }

    if (typeof parsed.id !== "number") return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);

    if (parsed.error) {
      const message =
        typeof parsed.error.message === "string"
          ? parsed.error.message
          : "unknown error";
      pending.reject(new Error(`codex app-server request failed: ${message}`));
      return;
    }

    pending.resolve(parsed.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function normalizeBackendPayload(
  payload: RateLimitStatusPayload,
  _capturedAt: number,
  _source: UsageSource,
): CodexUsageReport {
  const snapshot = normalizeBackendSnapshot(
    "codex",
    payload.rate_limit,
    _capturedAt,
  );
  if (!snapshot) {
    throw new Error(
      "Codex usage endpoint returned no displayable rate-limit windows.",
    );
  }
  return { snapshots: [snapshot] };
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

export function formatCodexUsageStatusline(
  report: CodexUsageReport,
  ctx: ExtensionContext,
  _model?: CodexUsageModel,
): string {
  const bar = formatReportBar(report);
  if (!bar) return formatStatuslineText(ctx, "n/a");
  const countdown = formatWeeklyResetCountdown(report);
  const barText = formatStatuslineBarText(ctx, bar);
  return countdown
    ? `${barText} ${ctx.ui.theme.fg("dim", countdown)}`
    : barText;
}

export function formatCodexUsageBar(
  report: CodexUsageReport,
): string | undefined {
  return formatReportBar(report);
}

export function formatWeeklyResetCountdown(
  report: CodexUsageReport,
  now = Date.now(),
): string | undefined {
  const resetAt = selectPrimaryCodexSnapshot(report)?.secondary?.resetAt;
  if (resetAt === undefined) return undefined;
  return formatResetCountdown(resetAt, now);
}

export function formatResetCountdown(
  resetAt: number,
  now = Date.now(),
): string {
  const remainingMs = Math.max(0, resetAt - now);
  if (remainingMs >= DAY_MS) {
    const dayTenths = Math.max(10, Math.ceil(remainingMs / DAY_TENTH_MS));
    return `${formatTenths(dayTenths)}d`;
  }
  if (remainingMs >= HOUR_MS) return `${Math.floor(remainingMs / HOUR_MS)}h`;
  if (remainingMs >= MINUTE_MS)
    return `${Math.floor(remainingMs / MINUTE_MS)}m`;
  return `${Math.floor(remainingMs / SECOND_MS)}s`;
}

export function nextResetCountdownDelayMs(
  report: CodexUsageReport,
  now = Date.now(),
): number | undefined {
  const resetAt = selectPrimaryCodexSnapshot(report)?.secondary?.resetAt;
  if (resetAt === undefined) return undefined;
  return nextResetCountdownDelayForRemainingMs(resetAt - now);
}

export function nextResetCountdownDelayForRemainingMs(
  remainingMs: number,
): number | undefined {
  if (remainingMs <= 0) return undefined;
  if (remainingMs >= DAY_MS) {
    const dayTenths = Math.max(10, Math.ceil(remainingMs / DAY_TENTH_MS));
    return Math.max(1, remainingMs - (dayTenths - 1) * DAY_TENTH_MS);
  }
  if (remainingMs >= HOUR_MS) {
    return Math.max(
      1,
      remainingMs - Math.floor(remainingMs / HOUR_MS) * HOUR_MS + 1,
    );
  }
  if (remainingMs >= MINUTE_MS) {
    return Math.max(
      1,
      remainingMs - Math.floor(remainingMs / MINUTE_MS) * MINUTE_MS + 1,
    );
  }
  return Math.max(
    1,
    remainingMs - Math.floor(remainingMs / SECOND_MS) * SECOND_MS + 1,
  );
}

function formatTenths(value: number): string {
  return value % 10 === 0 ? String(value / 10) : (value / 10).toFixed(1);
}

function formatReportBar(report: CodexUsageReport): string | undefined {
  const snapshot = selectPrimaryCodexSnapshot(report);
  if (!snapshot || (!snapshot.primary && !snapshot.secondary)) return undefined;
  return formatDualLimitBar(snapshot.primary, snapshot.secondary);
}

function formatStatuslineText(ctx: ExtensionContext, value: string): string {
  const label = ctx.ui.theme.fg("accent", STATUS_LABEL_TEXT);
  return `${label} ${ctx.ui.theme.fg("dim", value)}`;
}

function formatStatuslineBarText(ctx: ExtensionContext, bar: string): string {
  const label = ctx.ui.theme.fg("accent", STATUS_LABEL_TEXT);
  const value = ctx.ui.theme.bg("selectedBg", ctx.ui.theme.fg("dim", bar));
  return `${label} ${value}`;
}

function formatEmptyStatuslineBar(ctx: ExtensionContext): string {
  return formatStatuslineBarText(ctx, DUAL_BAR_CHARS[0].repeat(DUAL_BAR_WIDTH));
}

function formatStatuslineProblem(
  ctx: ExtensionContext,
  errors: UsageQueryError[],
): string {
  const label = ctx.ui.theme.fg("accent", STATUS_LABEL_TEXT);
  const value = isUsageUnavailable(errors)
    ? ctx.ui.theme.fg("muted", "n/a")
    : ctx.ui.theme.fg("error", "error");
  return `${label} ${value}`;
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

function selectPrimaryCodexSnapshot(
  report: CodexUsageReport,
): NormalizedRateLimitSnapshot | undefined {
  return report.snapshots.find(isPrimaryCodexSnapshot);
}

function normalizedUsageKey(value: string | undefined): string | undefined {
  const key = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || undefined;
}

function formatDualLimitBar(
  primary: NormalizedRateLimitWindow | undefined,
  secondary: NormalizedRateLimitWindow | undefined,
): string {
  const primaryParts = filledTwentieths(primary);
  const secondaryParts = filledTwentieths(secondary);
  let value = "";
  for (let index = 0; index < DUAL_BAR_WIDTH; index++) {
    const leftPart = index * 2 + 1;
    const rightPart = leftPart + 1;
    let mask = 0;
    if (primaryParts >= leftPart) mask |= 1;
    if (primaryParts >= rightPart) mask |= 2;
    if (secondaryParts >= leftPart) mask |= 4;
    if (secondaryParts >= rightPart) mask |= 8;
    value += DUAL_BAR_CHARS[mask];
  }
  return value;
}

function filledTwentieths(
  window: NormalizedRateLimitWindow | undefined,
): number {
  if (!window) return 0;
  return Math.round(remainingPercent(window) / 5);
}

function remainingPercent(window: NormalizedRateLimitWindow): number {
  return 100 - clampPercent(window.usedPercent);
}

function isPrimaryCodexSnapshot(
  snapshot: NormalizedRateLimitSnapshot,
): boolean {
  return normalizedUsageKey(snapshot.limitId) === "codex";
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function parseJsonObject(
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

function assertObject(
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

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
}

function redactErrorBody(body: string): string {
  return truncateEnd(
    body
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
      .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
      .trim(),
    MAX_ERROR_BODY_CHARS,
  );
}

function truncateEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
