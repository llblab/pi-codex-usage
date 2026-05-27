import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = 30 * 1000;
const REDRAW_BLINK_MS = 150;
const STATUS_KEY = "codex-usage";
const MAX_ERROR_BODY_CHARS = 600;
const STATUS_LABEL_TEXT = "codex";
const DUAL_BAR_CHARS = [
  " ",
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

type UsageQueryError = {
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
  let statuslineBlinkTimer: TimeoutHandle | undefined;
  let statuslineClearTimer: TimeoutHandle | undefined;
  let statuslineRefreshTimer: TimeoutHandle | undefined;
  let statuslineRequestId = 0;

  const clearStatuslineTimers = () => {
    if (statuslineBlinkTimer) clearTimeout(statuslineBlinkTimer);
    if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
    if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
    statuslineBlinkTimer = undefined;
    statuslineClearTimer = undefined;
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
    statuslineBlinkTimer = undefined;
    statuslineClearTimer = undefined;
    const text = formatCodexUsageStatusline(report, ctx, options.model);
    if (options.blink) {
      ctx.ui.setStatus(STATUS_KEY, formatEmptyStatuslineBar(ctx));
      statuslineBlinkTimer = setTimeout(() => {
        ctx.ui.setStatus(STATUS_KEY, text);
        statuslineBlinkTimer = undefined;
      }, REDRAW_BLINK_MS) as TimeoutHandle;
      statuslineBlinkTimer.unref?.();
    } else {
      ctx.ui.setStatus(STATUS_KEY, text);
    }
    if (options.autoRefresh) scheduleStatuslineRefresh(ctx);
    else scheduleTemporaryStatuslineClear(ctx);
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

    const result = await queryUsage(ctx, { timeoutMs: DEFAULT_TIMEOUT_MS });
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
  const snapshot = normalizeBackendSnapshot("codex", payload.rate_limit);
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
): NormalizedRateLimitSnapshot | undefined {
  if (rateLimit === null || rateLimit === undefined) return undefined;
  const details = assertObject(
    rateLimit,
    "rate limit",
  ) as BackendRateLimitDetails;
  const primary = normalizeBackendWindow(details.primary_window);
  const secondary = normalizeBackendWindow(details.secondary_window);
  if (!primary && !secondary) return undefined;
  return { limitId, primary, secondary };
}

function normalizeBackendWindow(
  value: unknown,
): NormalizedRateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(
    value,
    "rate-limit window",
  ) as BackendWindowSnapshot;
  const usedPercent = asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  return { usedPercent };
}

export function normalizeAppServerResponse(
  response: AppServerRateLimitResponse,
  _capturedAt: number,
): CodexUsageReport {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  const addSnapshot = (raw: unknown, fallbackId: string) => {
    const snapshot = normalizeAppServerSnapshot(raw, fallbackId);
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

  addSnapshot(response.rateLimits, "codex");
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
): NormalizedRateLimitSnapshot | undefined {
  if (raw === null || raw === undefined) return undefined;
  const snapshot = assertObject(
    raw,
    "app-server rate-limit snapshot",
  ) as AppServerRateLimitSnapshot;
  const limitId = asString(snapshot.limitId) ?? fallbackId;
  const primary = normalizeAppServerWindow(snapshot.primary);
  const secondary = normalizeAppServerWindow(snapshot.secondary);
  if (!primary && !secondary) return undefined;
  return { limitId, primary, secondary };
}

function normalizeAppServerWindow(
  value: unknown,
): NormalizedRateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(
    value,
    "app-server rate-limit window",
  ) as AppServerWindowSnapshot;
  const usedPercent = asNumber(window.usedPercent);
  if (usedPercent === undefined) return undefined;
  return { usedPercent };
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
  return formatStatuslineText(ctx, formatReportBar(report) ?? "n/a");
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

function formatEmptyStatuslineBar(ctx: ExtensionContext): string {
  return formatStatuslineText(ctx, "\u00a0\u00a0\u00a0\u00a0\u00a0");
}

function formatStatuslineProblem(
  ctx: ExtensionContext,
  errors: UsageQueryError[],
): string {
  const label = ctx.ui.theme.fg("accent", STATUS_LABEL_TEXT);
  const value = isUnavailable(errors)
    ? ctx.ui.theme.fg("muted", "n/a")
    : ctx.ui.theme.fg("error", "error");
  return `${label} ${value}`;
}

function isUnavailable(errors: UsageQueryError[]): boolean {
  return errors.some((error) => {
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
  });
}

function selectPrimaryCodexSnapshot(
  report: CodexUsageReport,
): NormalizedRateLimitSnapshot | undefined {
  return report.snapshots.find(isPrimaryCodexSnapshot) ?? report.snapshots[0];
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
  const primaryParts = filledTenths(primary);
  const secondaryParts = filledTenths(secondary);
  let value = "";
  for (let index = 0; index < 5; index++) {
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

function filledTenths(window: NormalizedRateLimitWindow | undefined): number {
  if (!window) return 0;
  return Math.round(remainingPercent(window) / 10);
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
