import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCodexUsageBar,
  formatCodexUsageStatusValue,
  formatCodexUsageStatusline,
  formatResetCountdown,
  formatWeeklyResetCountdown,
  isUsageUnavailable,
  nextResetCountdownDelayForRemainingMs,
  normalizeAppServerResponse,
  normalizeBackendPayload,
  type UsageQueryError,
} from "../index.ts";

const usageError = (message: string): UsageQueryError => ({
  source: "pi-auth",
  message,
});

const secondMs = 1000;
const minuteMs = 60 * secondMs;
const hourMs = 60 * minuteMs;
const hourTenthMs = 6 * minuteMs;
const dayMs = 24 * hourMs;
const dayTenthMs = 144 * minuteMs;

const testCtx = {
  ui: {
    theme: {
      fg: (name: string, value: string) => `<fg:${name}>${value}</fg>`,
      bg: (name: string, value: string) => `<bg:${name}>${value}</bg>`,
    },
  },
} as never;

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

  assert.equal(report.snapshots.length, 2);
  assert.deepEqual(report.snapshots[0], {
    limitId: "codex",
    primary: { usedPercent: 10 },
    secondary: { usedPercent: 30 },
  });
  assert.equal(report.snapshots[1]?.limitId, "spark");
  assert.deepEqual(report.snapshots[1]?.primary, {
    usedPercent: 20,
    resetAt: capturedAt + 3600 * 1000,
  });
  assert.equal(report.snapshots[1]?.secondary, undefined);
});

test("formats the dual quota bar with 20 steps per window", () => {
  assert.equal(
    formatCodexUsageBar({
      snapshots: [
        {
          limitId: "codex",
          primary: { usedPercent: 0 },
          secondary: { usedPercent: 0 },
        },
      ],
    }),
    "██████████",
  );

  assert.equal(
    formatCodexUsageBar({
      snapshots: [
        {
          limitId: "codex",
          primary: { usedPercent: 50 },
          secondary: { usedPercent: 100 },
        },
      ],
    }),
    "▀▀▀▀▀⠀⠀⠀⠀⠀",
  );
});

test("formats weekly reset countdown by remaining duration bucket", () => {
  const now = Date.parse("2026-05-28T00:00:00.000Z");

  assert.equal(formatResetCountdown(now + 7 * dayMs, now), "7d");
  assert.equal(
    formatResetCountdown(
      now + 6 * dayMs + 23 * hourMs + 59 * minuteMs + 1,
      now,
    ),
    "7d",
  );
  assert.equal(
    formatResetCountdown(now + 6 * dayMs + 21 * hourMs + 36 * minuteMs, now),
    "6.9d",
  );
  assert.equal(
    formatResetCountdown(now + 6 * dayMs + 14 * hourMs + 24 * minuteMs, now),
    "6.6d",
  );
  assert.equal(
    formatResetCountdown(now + 5 * dayMs + 2 * hourMs + 24 * minuteMs, now),
    "5.1d",
  );
  assert.equal(formatResetCountdown(now + 5 * dayMs, now), "5d");
  assert.equal(
    formatResetCountdown(now + dayMs + 2 * hourMs + 24 * minuteMs, now),
    "1.1d",
  );
  assert.equal(formatResetCountdown(now + dayMs, now), "24h");
  assert.equal(
    formatResetCountdown(now + 23 * hourMs + 59 * minuteMs, now),
    "24h",
  );
  assert.equal(
    formatResetCountdown(now + 23 * hourMs + 42 * minuteMs, now),
    "23.7h",
  );
  assert.equal(
    formatResetCountdown(now + 20 * hourMs + 6 * minuteMs, now),
    "20.1h",
  );
  assert.equal(formatResetCountdown(now + 20 * hourMs, now), "20h");
  assert.equal(
    formatResetCountdown(now + 19 * hourMs + 54 * minuteMs, now),
    "19.9h",
  );
  assert.equal(
    formatResetCountdown(now + hourMs + 24 * minuteMs, now),
    "1.4h",
  );
  assert.equal(
    formatResetCountdown(now + hourMs + 18 * minuteMs, now),
    "1.3h",
  );
  assert.equal(
    formatResetCountdown(now + hourMs + 12 * minuteMs, now),
    "1.2h",
  );
  assert.equal(
    formatResetCountdown(now + hourMs + 6 * minuteMs, now),
    "1.1h",
  );
  assert.equal(formatResetCountdown(now + hourMs, now), "1h");
  assert.equal(
    formatResetCountdown(now + 59 * minuteMs + 59 * secondMs, now),
    "59m",
  );
  assert.equal(formatResetCountdown(now + 59 * secondMs + 999, now), "59s");
  assert.equal(formatResetCountdown(now + 999, now), "0s");
  assert.equal(formatResetCountdown(now - secondMs, now), "0s");
});

test("schedules countdown redraws at the next display boundary", () => {
  assert.equal(nextResetCountdownDelayForRemainingMs(7 * dayMs), dayTenthMs);
  assert.equal(
    nextResetCountdownDelayForRemainingMs(6 * dayMs + 23 * hourMs),
    84 * minuteMs,
  );
  assert.equal(
    nextResetCountdownDelayForRemainingMs(23 * hourMs + 59 * minuteMs),
    5 * minuteMs,
  );
  assert.equal(
    nextResetCountdownDelayForRemainingMs(23 * hourMs + 15 * minuteMs),
    3 * minuteMs,
  );
  assert.equal(
    nextResetCountdownDelayForRemainingMs(20 * hourMs),
    hourTenthMs,
  );
  assert.equal(nextResetCountdownDelayForRemainingMs(hourMs), 1);
  assert.equal(
    nextResetCountdownDelayForRemainingMs(59 * minuteMs + 30 * secondMs),
    30 * secondMs + 1,
  );
  assert.equal(nextResetCountdownDelayForRemainingMs(59 * secondMs + 250), 251);
  assert.equal(nextResetCountdownDelayForRemainingMs(0), undefined);
});

test("formats statusline countdown outside the quota bar background", () => {
  const now = Date.parse("2026-05-28T00:00:00.000Z");
  const originalDateNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(
      formatCodexUsageStatusline(
        {
          snapshots: [
            {
              limitId: "codex",
              primary: { usedPercent: 0 },
              secondary: { usedPercent: 0, resetAt: now + 6 * dayMs },
            },
          ],
        },
        testCtx,
      ),
      "<fg:accent>codex</fg> <bg:selectedBg><fg:dim>██████████</fg></bg> <fg:dim>6d</fg>",
    );
  } finally {
    Date.now = originalDateNow;
  }
});

test("ignores non-codex usage buckets", () => {
  assert.equal(
    formatCodexUsageBar({
      snapshots: [
        {
          limitId: "spark",
          primary: { usedPercent: 0 },
          secondary: { usedPercent: 0 },
        },
      ],
    }),
    undefined,
  );
});

test("formats reusable compact Codex status values", () => {
  const now = Date.parse("2026-05-28T00:00:00.000Z");
  assert.equal(
    formatCodexUsageStatusValue(
      {
        snapshots: [
          {
            limitId: "codex",
            primary: { usedPercent: 50 },
            secondary: { usedPercent: 100, resetAt: now + 23 * hourMs },
          },
        ],
      },
      now,
    ),
    "▀▀▀▀▀⠀⠀⠀⠀⠀ 23h",
  );
});

test("formats weekly reset countdown from the secondary codex window", () => {
  const now = Date.parse("2026-05-28T00:00:00.000Z");

  assert.equal(
    formatWeeklyResetCountdown(
      {
        snapshots: [
          {
            limitId: "spark",
            secondary: { usedPercent: 0, resetAt: now + 2 * dayMs },
          },
          {
            limitId: "codex",
            secondary: { usedPercent: 50, resetAt: now + 3 * hourMs },
          },
        ],
      },
      now,
    ),
    "3h",
  );
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
