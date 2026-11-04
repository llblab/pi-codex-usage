/** Domain: quota transport. Owns: Pi auth, Codex app-server fallback and errors. Excludes: shared leadership and UI. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertObject, errorMessage, isOpenAICodexModel, normalizeAppServerResponse, normalizeBackendPayload, parseJsonObject, selectUsageSnapshot, type AppServerRateLimitResponse, type CodexUsageModel, type CodexUsageReport, type RateLimitStatusPayload, type UsageQueryError } from "./usage.ts";
const CODEX_USAGE_LIMIT_ID = "codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_ERROR_BODY_CHARS = 600;
type PiModel = NonNullable<ExtensionContext["model"]>;
type QueryUsageOptions = { timeoutMs: number };
export type QueryUsageResult = { ok: true; report: CodexUsageReport } | { ok: false; errors: UsageQueryError[] };
type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown; code?: unknown };
};

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export async function queryUsage(
  ctx: ExtensionContext,
  options: Pick<QueryUsageOptions, "timeoutMs">,
  model: CodexUsageModel | undefined,
  mayQuery: () => boolean,
): Promise<QueryUsageResult | undefined> {
  const errors: UsageQueryError[] = [];
  const sources = ["pi-auth", "codex-app-server"] as const;

  for (const source of sources) {
    if (!mayQuery()) return undefined;
    try {
      const report =
        source === "pi-auth"
          ? await queryViaPiAuth(ctx, options.timeoutMs, mayQuery)
          : await queryViaCodexAppServer(options.timeoutMs, mayQuery);
      if (!report) return undefined;
      if (
        selectUsageSnapshot(report, CODEX_USAGE_LIMIT_ID) ||
        report.credits
      ) {
        return { ok: true, report };
      }
      errors.push({
        source,
        message: `${source} returned no displayable codex rate-limit windows`,
      });
    } catch (cause) {
      errors.push({ source, message: errorMessage(cause), cause });
    }
  }

  return { ok: false, errors };
}

async function queryViaPiAuth(
  ctx: ExtensionContext,
  timeoutMs: number,
  mayQuery: () => boolean,
): Promise<CodexUsageReport | undefined> {
  const auth = await resolvePiCodexAuth(ctx);
  if (!auth) {
    throw new Error(
      "No Pi OpenAI Codex subscription auth was available. Use an openai or openai-codex subscription model or run /login for OpenAI ChatGPT.",
    );
  }

  if (!mayQuery()) return undefined;
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
  // Proxy models display local subscription quota. Auth candidates remain
  // openai/openai-codex; proxy credentials are not resolved here.
  const models = codexAuthCandidateModels(ctx);
  const errors: string[] = [];

  for (const model of models) {
    if (model.provider === "openai" && !ctx.modelRegistry.isUsingOAuth(model)) continue;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      errors.push(auth.error);
      continue;
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(auth.headers ?? {})) {
      if (value !== null) headers[name] = value;
    }
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
    if (!model || !isOpenAICodexModel(model)) return;
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
  mayQuery: () => boolean,
): Promise<CodexUsageReport | undefined> {
  const client = new CodexAppServerClient(timeoutMs);
  try {
    await client.start();
    if (!mayQuery()) return undefined;
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
    if (!mayQuery()) return undefined;
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

const WINDOWS_CODEX_TARGETS: Record<string, string> = {
  x64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
};

/**
 * npm installs Codex behind a `codex.cmd` shim that a shell-free `spawn` cannot
 * launch, so on Windows resolve the native executable used by the npm platform
 * package. Other platforms keep plain PATH lookup. Launching the native binary
 * attaches disposal to the app-server process instead of a shell or Node shim.
 */
export function resolveCodexExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  arch: string = process.arch,
): string {
  if (platform !== "win32") return "codex";
  const target = WINDOWS_CODEX_TARGETS[arch];
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const entry of path.split(";")) {
    // Ignore empty entries rather than searching the current working directory.
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    const direct = join(directory, "codex.exe");
    if (existsSync(direct)) return direct;
    // A `.cmd` entry means an npm install; its native binary lives in the platform package.
    if (!target || !existsSync(join(directory, "codex.cmd"))) continue;
    const packageDirs = [
      join(directory, "node_modules", "@openai", "codex", "node_modules", "@openai", `codex-win32-${arch}`),
      join(directory, "node_modules", "@openai", `codex-win32-${arch}`),
    ];
    for (const packageDir of packageDirs) {
      const binary = join(packageDir, "vendor", target, "bin", "codex.exe");
      if (existsSync(binary)) return binary;
    }
  }
  throw new Error(
    "Could not find a native Codex executable on PATH. Install Codex with npm install -g @openai/codex@latest, then restart Pi so it inherits the updated PATH.",
  );
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
      const child = spawn(resolveCodexExecutable(), ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
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
