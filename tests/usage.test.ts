import assert from "node:assert/strict";
import test from "node:test";
import { canReuseCachedReport, isFullyAvailableReport, isUsageUnavailable, normalizeBackendPayload, normalizeAppServerResponse, type UsageQueryError } from "../lib/usage.ts";
import { formatCodexUsageStatusValue, nextResetCountdownDelayMs } from "../lib/status-format.ts";

const usageError = (message: string): UsageQueryError => ({ source: "pi-auth", message });
const hourMs = 60 * 60 * 1000;
const codexModel = { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", provider: "openai-codex" };
const otherCodexModel = { id: "gpt-5.4", name: "GPT-5.4", provider: "openai-codex" };

test("normalizes backend primary and secondary windows", () => {
  const capturedAt = Date.parse("2026-05-28T00:00:00.000Z");
  const report = normalizeBackendPayload(
    {
      rate_limit: {
        primary_window: { used_percent: 25 },
        secondary_window: {
          used_percent: "50",
          reset_at: "2026-06-04T00:00:00.000Z",
        },
      },
    },
    capturedAt,
    "pi-auth",
  );

  assert.deepEqual(report, {
    snapshots: [
      {
        limitId: "codex",
        primary: { usedPercent: 25 },
        secondary: {
          usedPercent: 50,
          resetAt: Date.parse("2026-06-04T00:00:00.000Z"),
        },
      },
    ],
  });
});

test("normalizes credits-only backend usage", () => {
  const capturedAt = Date.parse("2026-05-28T00:00:00.000Z");
  const report = normalizeBackendPayload(
    {
      spend_control: {
        individual_limit: {
          limit: 100,
          used: 25,
          remaining: 75,
          reset_after_seconds: 3600,
        },
      },
    },
    capturedAt,
    "pi-auth",
  );

  assert.deepEqual(report, {
    snapshots: [],
    credits: {
      remainingPercent: 75,
      resetAt: capturedAt + hourMs,
    },
  });
  assert.equal(formatCodexUsageStatusValue(report, capturedAt), "75% 1h");
  assert.equal(nextResetCountdownDelayMs(report, capturedAt), 1);
  assert.equal(canReuseCachedReport(report, codexModel), true);
});

test("ignores additional backend limits, including retired Spark quotas", () => {
  const capturedAt = Date.parse("2026-05-28T00:00:00.000Z");
  const report = normalizeBackendPayload(
    {
      rate_limit: {
        primary_window: { used_percent: 1 },
        secondary_window: { used_percent: 92 },
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          metered_feature: "codex_bengalfox",
          rate_limit: {
            primary_window: { used_percent: 0 },
            secondary_window: {
              used_percent: 0,
              reset_after_seconds: 604800,
            },
          },
        },
      ],
    },
    capturedAt,
    "pi-auth",
  );

  assert.deepEqual(report.snapshots, [
    {
      limitId: "codex",
      primary: { usedPercent: 1 },
      secondary: { usedPercent: 92 },
    },
  ]);
});

test("normalizes app-server array rate limits and merges duplicate limit ids", () => {
  const capturedAt = Date.parse("2026-05-28T00:00:00.000Z");
  const report = normalizeAppServerResponse(
    {
      rateLimits: [
        {
          limitId: "codex",
          primary: { usedPercent: 10 },
        },
        {
          limitId: "spark",
          primary: { usedPercent: 20, resetAfterSeconds: 3600 },
        },
        { limitId: "codex", secondary: { usedPercent: "30" } },
      ],
    },
    capturedAt,
  );

  assert.equal(report.snapshots.length, 1);
  assert.deepEqual(report.snapshots[0], {
    limitId: "codex",
    primary: { usedPercent: 10 },
    secondary: { usedPercent: 30 },
  });
  assert.equal(report.snapshots[1], undefined);
  assert.throws(
    () => normalizeAppServerResponse(
      { rateLimits: { limitId: "spark", primary: { usedPercent: 20 } } },
      capturedAt,
    ),
    /no displayable rate-limit windows/,
  );
});

test("detects zero usage across every available window as fully available", () => {
  assert.equal(
    isFullyAvailableReport({
      snapshots: [
        {
          limitId: "codex",
          primary: { usedPercent: 0 },
          secondary: { usedPercent: 0 },
        },
      ],
    }),
    true,
  );
  assert.equal(
    isFullyAvailableReport({
      snapshots: [
        {
          limitId: "codex",
          primary: { usedPercent: 0 },
          secondary: { usedPercent: 1 },
        },
      ],
    }),
    false,
  );
  assert.equal(
    isFullyAvailableReport({
      snapshots: [{ limitId: "codex", primary: { usedPercent: 0 } }],
    }),
    true,
  );
});

test("all Codex models reuse the same cache and ignore unrelated quotas", () => {
  const codexReport = {
    snapshots: [
      {
        limitId: "codex",
        primary: { usedPercent: 10 },
        secondary: { usedPercent: 20 },
      },
    ],
  };
  const unrelatedReport = {
    snapshots: [
      {
        limitId: "spark",
        primary: { usedPercent: 0 },
        secondary: { usedPercent: 0 },
      },
    ],
  };

  for (const model of [codexModel, otherCodexModel]) {
    assert.equal(canReuseCachedReport(codexReport, model), true);
    assert.equal(canReuseCachedReport(unrelatedReport, model), false);
  }
});

test("classifies n/a only when all query failures are unavailable states", () => {
  assert.equal(
    isUsageUnavailable([
      usageError("No Pi OpenAI Codex subscription auth was available."),
      { source: "codex-app-server", message: "rate limits unavailable" },
    ]),
    true,
  );

  assert.equal(
    isUsageUnavailable([
      { source: "pi-auth-openai", message: "New Pi OpenAI OAuth credential is not accepted by the Codex usage endpoint" },
      { source: "codex-cli-auth", message: "No usable Codex CLI ChatGPT auth was available" },
    ]),
    true,
  );

  assert.equal(
    isUsageUnavailable([
      usageError("No Pi OpenAI Codex subscription auth was available."),
      {
        source: "codex-app-server",
        message: "Failed to start codex app-server: ENOENT",
      },
    ]),
    false,
  );

  assert.equal(isUsageUnavailable([]), false);
});
