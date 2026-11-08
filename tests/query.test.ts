import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { queryUsage, resolveQuotaAuthCandidates } from "../lib/query.ts";

type TestModel = { id: string; name: string; provider: string };
const model = (provider: string, id = "current"): TestModel => ({ id, name: id, provider });
const response = () => new Response(JSON.stringify({
  rate_limit: { secondary_window: { used_percent: 25 } },
}));
const expected = { ok: true, report: { snapshots: [{ limitId: "codex", primary: undefined, secondary: { usedPercent: 25 } }] } };

function jwt(claims: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" },
    ...claims,
  };
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

const legacyJwt = jwt({ sub: "pi-legacy" });
const compatibleNewJwt = jwt({
  sub: "pi-new-compatible",
  aud: "https://api.openai.com/v1",
  scope: "chatgpt.tokens.use.direct",
});
const incompatibleNewJwt = jwt({
  sub: "pi-new",
  aud: "https://api.openai.com/v1",
  scope: "chatgpt.tokens.use.direct",
  "https://api.openai.com/auth": { per_user_salt: "fixture" },
});
const codexJwt = jwt({ sub: "codex-cli" });

let tempDir: string;
let previousCodexHome: string | undefined;
before(() => {
  previousCodexHome = process.env.CODEX_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "pi-codex-usage-query-"));
  process.env.CODEX_HOME = tempDir;
});
after(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(tempDir, { recursive: true, force: true });
});

async function withCodexAuth<T>(auth: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const file = join(tempDir, "auth.json");
  writeFileSync(file, JSON.stringify(auth));
  try {
    return await run();
  } finally {
    rmSync(file, { force: true });
  }
}

function authContext(
  resolve: (candidate: TestModel) => unknown,
  active: TestModel = model("openai"),
): never {
  return {
    model: active,
    modelRegistry: {
      getAvailable: () => [active, model("openai-codex", "legacy")],
      getAll: () => [model("openai-codex", "legacy")],
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: resolve,
    },
  } as never;
}

for (const provider of ["openai", "openai-codex"]) test(`${provider}: quota auth works with only the active subscription provider`, async () => {
  const previous = globalThis.fetch;
  const active = model(provider);
  const token = provider === "openai" ? compatibleNewJwt : legacyJwt;
  let requests = 0;
  const ctx = {
    model: active,
    modelRegistry: {
      getAvailable: () => [active],
      getAll: () => [active],
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async (candidate: TestModel) => {
        assert.equal(candidate, active);
        return {
          ok: true,
          apiKey: "unused",
          headers: {
            authorization: `Bearer ${token}`,
            "ChatGPT-Account-Id": "account-fixture",
            ignored: null,
          },
        };
      },
    },
  } as never;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    assert.deepEqual(init?.headers, {
      authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": "account-fixture",
      "User-Agent": "pi-codex-usage",
      Accept: "application/json",
    });
    return response();
  };
  try {
    assert.deepEqual(await queryUsage(ctx, { timeoutMs: 1000 }, active, () => true), expected);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = previous; }
});

test("OpenAI API-key auth is skipped and subscription auth candidates are deduplicated across providers", async () => {
  const previous = globalThis.fetch;
  const active = model("openai");
  const legacy = model("openai-codex", "unavailable");
  const subscription = model("openai-codex", "subscription");
  const candidates: string[] = [];
  const ctx = {
    model: active,
    modelRegistry: {
      getAvailable: () => [active, legacy, model("other")],
      getAll: () => [legacy, subscription],
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async (candidate: TestModel) => {
        assert.notEqual(candidate.provider, "openai");
        candidates.push(candidate.id);
        return candidate === legacy
          ? { ok: false, error: "No subscription auth" }
          : { ok: true, apiKey: legacyJwt, headers: {} };
      },
    },
  } as never;
  globalThis.fetch = async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${legacyJwt}`);
    return response();
  };
  try {
    assert.deepEqual(await queryUsage(ctx, { timeoutMs: 1000 }, active, () => true), expected);
    assert.deepEqual(candidates, ["unavailable", "subscription"]);
  } finally { globalThis.fetch = previous; }
});

test("quota auth can find an OpenAI subscription model in the registry while another provider is selected", async () => {
  const previous = globalThis.fetch;
  const active = model("other");
  const subscription = model("openai");
  const ctx = {
    model: active,
    modelRegistry: {
      getAvailable: () => [],
      getAll: () => [active, subscription],
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async (candidate: TestModel) => {
        assert.equal(candidate, subscription);
        return { ok: true, apiKey: compatibleNewJwt, headers: {} };
      },
    },
  } as never;
  globalThis.fetch = async () => response();
  try {
    assert.deepEqual(await queryUsage(ctx, { timeoutMs: 1000 }, active, () => true), expected);
  } finally { globalThis.fetch = previous; }
});

test("quota queries recheck leadership after asynchronous OpenAI subscription auth", async () => {
  const previous = globalThis.fetch;
  const active = model("openai");
  let allowed = false;
  let authCalls = 0;
  const ctx = {
    model: active,
    modelRegistry: {
      getAvailable: () => [active],
      getAll: () => [active],
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async () => {
        authCalls++;
        allowed = false;
        return { ok: true, apiKey: compatibleNewJwt, headers: {} };
      },
    },
  } as never;
  globalThis.fetch = async () => { throw new Error("Unexpected quota fetch"); };
  try {
    assert.equal(await queryUsage(ctx, { timeoutMs: 1000 }, active, () => allowed), undefined);
    assert.equal(authCalls, 0);
    allowed = true;
    assert.equal(await queryUsage(ctx, { timeoutMs: 1000 }, active, () => allowed), undefined);
    assert.equal(authCalls, 1);
  } finally { globalThis.fetch = previous; }
});

test("incompatible new Pi OAuth falls through to the local Codex CLI credential", async () => {
  const previous = globalThis.fetch;
  const active = model("openai");
  let requests = 0;
  const ctx = {
    model: active,
    modelRegistry: {
      getAvailable: () => [active],
      getAll: () => [active],
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: incompatibleNewJwt,
        headers: {},
      }),
    },
  } as never;
  globalThis.fetch = async (_url, init) => {
    requests++;
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${codexJwt}`);
    assert.equal((init?.headers as Record<string, string>)["ChatGPT-Account-Id"], "account-fixture");
    return response();
  };
  try {
    await withCodexAuth({
      auth_mode: "chatgpt",
      tokens: { access_token: codexJwt, account_id: "account-fixture" },
    }, async () => {
      assert.deepEqual(await queryUsage(ctx, { timeoutMs: 1000 }, active, () => true), expected);
      assert.equal(requests, 1);
    });
  } finally { globalThis.fetch = previous; }
});

test("legacy Pi auth and Codex CLI auth are preferred over incompatible new Pi OAuth", async () => {
  await withCodexAuth({
    auth_mode: "chatgpt",
    tokens: { access_token: codexJwt, account_id: "account-fixture" },
  }, async () => {
    const ctx = authContext((candidate) => candidate.provider === "openai-codex"
      ? { ok: true, headers: { Authorization: `Bearer ${legacyJwt}` } }
      : { ok: true, apiKey: incompatibleNewJwt, headers: {} });
    const { candidates, errors } = await resolveQuotaAuthCandidates(
      ctx,
      { CODEX_HOME: tempDir } as NodeJS.ProcessEnv,
    );

    assert.deepEqual(candidates.map((candidate) => candidate.source), [
      "pi-auth-openai-codex",
      "codex-cli-auth",
    ]);
    assert.equal(candidates[0]?.headers["ChatGPT-Account-Id"], "account-fixture");
    assert.equal(candidates[0]?.headers.Accept, "application/json");
    assert.equal(candidates[1]?.headers.Authorization, `Bearer ${codexJwt}`);
    assert.ok(errors.some((error) =>
      error.source === "pi-auth-openai" && /not accepted/.test(error.message)));
  });
});

test("new Pi OAuth is used when its token carries a Codex account claim", async () => {
  const ctx = authContext((candidate) => candidate.provider === "openai"
    ? { ok: true, apiKey: compatibleNewJwt, headers: {} }
    : { ok: false, error: "No legacy subscription auth" });
  const { candidates } = await resolveQuotaAuthCandidates(
    ctx,
    { CODEX_HOME: tempDir } as NodeJS.ProcessEnv,
  );

  assert.deepEqual(candidates.map((candidate) => candidate.source), ["pi-auth-openai"]);
  assert.equal(candidates[0]?.headers["ChatGPT-Account-Id"], "account-fixture");
});

test("API key auth and non-Codex CLI credentials are skipped", async () => {
  await withCodexAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-fixture" }, async () => {
    const ctx = authContext(() => ({ ok: true, apiKey: "sk-fixture", headers: {} }));
    const { candidates, errors } = await resolveQuotaAuthCandidates(
      ctx,
      { CODEX_HOME: tempDir } as NodeJS.ProcessEnv,
    );

    assert.deepEqual(candidates, []);
    assert.ok(errors.some((error) => error.source === "codex-cli-auth"));
  });
});

test("expired Codex CLI tokens and failed Pi auth resolve to unavailable sources", async () => {
  await withCodexAuth({
    auth_mode: "chatgpt",
    tokens: {
      access_token: jwt({ sub: "expired", exp: Math.floor(Date.now() / 1000) - 60 }),
      account_id: "account-fixture",
    },
  }, async () => {
    const ctx = authContext(() => ({ ok: false, error: "No subscription auth" }));
    const { candidates, errors } = await resolveQuotaAuthCandidates(
      ctx,
      { CODEX_HOME: tempDir } as NodeJS.ProcessEnv,
    );

    assert.deepEqual(candidates, []);
    assert.ok(errors.some((error) => error.source === "pi-auth-openai-codex"));
    assert.ok(errors.some((error) => error.source === "codex-cli-auth"));
  });
});
