import assert from "node:assert/strict";
import test from "node:test";
import { queryUsage } from "../lib/query.ts";

type TestModel = { id: string; name: string; provider: string };
const model = (provider: string, id = "current"): TestModel => ({ id, name: id, provider });
const response = () => new Response(JSON.stringify({
  rate_limit: { secondary_window: { used_percent: 25 } },
}));
const expected = { ok: true, report: { snapshots: [{ limitId: "codex", primary: undefined, secondary: { usedPercent: 25 } }] } };

for (const provider of ["openai", "openai-codex"]) test(`${provider}: quota auth works with only the active subscription provider`, async () => {
  const previous = globalThis.fetch;
  const active = model(provider);
  let requests = 0;
  const ctx = {
    model: active,
    modelRegistry: {
      getAvailable: () => [active],
      getAll: () => [active],
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async (candidate: TestModel) => {
        assert.equal(candidate, active);
        return { ok: true, apiKey: "unused", headers: { authorization: "Bearer subscription-fixture", "ChatGPT-Account-Id": "account-fixture", ignored: null } };
      },
    },
  } as never;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    assert.deepEqual(init?.headers, {
      authorization: "Bearer subscription-fixture",
      "ChatGPT-Account-Id": "account-fixture",
      "User-Agent": "pi-codex-usage",
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
        return candidate === legacy ? { ok: false, error: "No subscription auth" } : { ok: true, apiKey: "subscription-fixture" };
      },
    },
  } as never;
  globalThis.fetch = async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer subscription-fixture");
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
        return { ok: true, apiKey: "subscription-fixture" };
      },
    },
  } as never;
  globalThis.fetch = async () => response();
  try {
    assert.deepEqual(await queryUsage(ctx, { timeoutMs: 1000 }, active, () => true), expected);
  } finally { globalThis.fetch = previous; }
});

for (const id of ["codex/gpt-6.1-sol", "codex/gpt-6-astra"]) test(`Magpie ${id}: quota uses local subscription auth, never proxy or OpenAI API-key credentials`, async () => {
  const previous = globalThis.fetch;
  const active = model("magpie", id);
  const apiKeyModel = model("openai", "api-key-only");
  const subscription = model("openai-codex", "local-subscription");
  let requests = 0;
  const ctx = {
    model: active,
    modelRegistry: {
      getAvailable: () => [active, apiKeyModel],
      getAll: () => [active, apiKeyModel, subscription],
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async (candidate: TestModel) => {
        assert.equal(candidate, subscription, "proxy credentials must never be resolved");
        return { ok: true, apiKey: "local-subscription-fixture", headers: { "ChatGPT-Account-Id": "local-account-fixture" } };
      },
    },
  } as never;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    assert.deepEqual(init?.headers, {
      Authorization: "Bearer local-subscription-fixture",
      "ChatGPT-Account-Id": "local-account-fixture",
      "User-Agent": "pi-codex-usage",
    });
    return response();
  };
  try {
    assert.deepEqual(await queryUsage(ctx, { timeoutMs: 1000 }, active, () => true), expected);
    assert.equal(requests, 1);
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
        return { ok: true, apiKey: "subscription-fixture" };
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
