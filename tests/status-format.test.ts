import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBackendPayload, normalizeAppServerResponse } from "../lib/usage.ts";
import {
  appendFastStatus,
  formatCodexUsageBar,
  formatCodexUsageLoadingBar,
  formatCodexUsageStatusValue,
  formatCodexUsageStatusline,
  formatStatuslineLoading,
  formatStatuslineProblem,
  formatResetCountdown,
  formatWeeklyResetCountdown,
  nextResetCountdownDelayForRemainingMs,
  nextResetCountdownDelayMs,
} from "../lib/status-format.ts";

const secondMs = 1000;
const minuteMs = 60 * secondMs;
const hourMs = 60 * minuteMs;
const hourTenthMs = 6 * minuteMs;
const dayMs = 24 * hourMs;
const dayTenthMs = 144 * minuteMs;
const codexModel = { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", provider: "openai-codex" };
const otherCodexModel = { id: "gpt-5.4", name: "GPT-5.4", provider: "openai-codex" };
const testCtx = {
  ui: {
    theme: {
      fg: (name: string, value: string) => `<fg:${name}>${value}</fg>`,
      bg: (name: string, value: string) => `<bg:${name}>${value}</bg>`,
    },
  },
} as never;

test("Magpie quota, loading and problems use the same Codex label as native providers", () => {
  const model = { provider: "magpie", id: "codex/gpt-6.1-sol", name: "Codex" };
  const report = { snapshots: [{ limitId: "codex", secondary: { usedPercent: 33 } }] };
  assert.equal(formatCodexUsageStatusline(report, testCtx, model), "<fg:accent>codex</fg> <fg:dim>67%</fg>");
  const dual = { snapshots: [{ limitId: "codex", primary: { usedPercent: 25 }, secondary: { usedPercent: 50 } }] };
  assert.match(formatCodexUsageStatusline(dual, testCtx, model), /^<fg:accent>codex<\/fg> <bg:userMessageBg>/);
  assert.match(formatCodexUsageStatusline({ snapshots: [], credits: { remainingPercent: 81 } }, testCtx, model), /codex<\/fg>.*81%/);
  assert.match(formatStatuslineLoading(testCtx, 0, model), /codex<\/fg>/);
  assert.match(formatStatuslineProblem(testCtx, true, model), /codex<\/fg>.*n\/a/);
  assert.match(formatStatuslineProblem(testCtx, false, model), /codex<\/fg>.*error/);
});

test("Fast suffix uses the same dim theme role as the reset countdown", () => {
  const text = "codex ██████▀▀▀▀ <fg:dim>6d</fg>";
  assert.equal(appendFastStatus(testCtx, text, true), `${text} <fg:dim>fast</fg>`);
  assert.equal(appendFastStatus(testCtx, "codex n/a", true), "codex n/a <fg:dim>fast</fg>");
  assert.equal(appendFastStatus(testCtx, "codex error", true), "codex error <fg:dim>fast</fg>");
  assert.equal(appendFastStatus(testCtx, text, false), text);
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

test("formats a single weekly window as remaining percentage and reset", () => {
  const now = Date.parse("2026-05-28T00:00:00.000Z");
  const report = {
    snapshots: [
      {
        limitId: "codex",
        primary: { usedPercent: 33, resetAt: now + 7 * dayMs },
      },
    ],
  };

  assert.equal(formatCodexUsageStatusValue(report, now), "67% 7d");
  assert.equal(
    formatCodexUsageStatusline(
      {
        snapshots: [
          { limitId: "codex", primary: { usedPercent: 33 } },
        ],
      },
      testCtx,
    ),
    "<fg:accent>codex</fg> <fg:dim>67%</fg>",
  );
  assert.equal(formatWeeklyResetCountdown(report, now), "7d");
  assert.equal(nextResetCountdownDelayMs(report, now), dayMs / 10);
});

test("prefers rate-limit countdown scheduling when credits are also present", () => {
  const now = Date.parse("2026-05-28T00:00:00.000Z");
  assert.equal(
    nextResetCountdownDelayMs(
      {
        snapshots: [
          {
            limitId: "codex",
            primary: { usedPercent: 33, resetAt: now + 7 * dayMs },
          },
        ],
        credits: { remainingPercent: 75, resetAt: now + hourMs },
      },
      now,
    ),
    dayMs / 10,
  );
});

test("formats a secondary-only weekly window as remaining percentage", () => {
  assert.equal(
    formatCodexUsageStatusValue({
      snapshots: [
        {
          limitId: "codex",
          secondary: { usedPercent: 50 },
        },
      ],
    }),
    "50%",
  );
});

test("formats counter-moving loading markers for both quota windows", () => {
  assert.equal(formatCodexUsageLoadingBar(0), "▘⠀⠀⠀⠀⠀⠀⠀⠀▗");
  assert.equal(formatCodexUsageLoadingBar(1), "▝⠀⠀⠀⠀⠀⠀⠀⠀▖");
  assert.equal(formatCodexUsageLoadingBar(9), "⠀⠀⠀⠀▝▖⠀⠀⠀⠀");
  assert.equal(formatCodexUsageLoadingBar(19), "▖⠀⠀⠀⠀⠀⠀⠀⠀▝");
  assert.equal(formatCodexUsageLoadingBar(20), "▗⠀⠀⠀⠀⠀⠀⠀⠀▘");
  assert.equal(formatCodexUsageLoadingBar(37), "▝⠀⠀⠀⠀⠀⠀⠀⠀▖");
  assert.equal(formatCodexUsageLoadingBar(38), "▘⠀⠀⠀⠀⠀⠀⠀⠀▗");
  assert.equal(formatCodexUsageLoadingBar(Number.NaN), "▘⠀⠀⠀⠀⠀⠀⠀⠀▗");
});

test("aligns empty quota halves and shared error background with rounded zero percent", () => {
  for (const [usedPercent, displayedRemaining] of [[98, 2], [99, 1], [99.5, 1], [99.51, 0], [99.9, 0], [100, 0], [101, 0]]) {
    const exhausted = displayedRemaining === 0;
    const background = exhausted ? "toolErrorBg" : "userMessageBg";
    assert.equal(
      formatCodexUsageStatusValue({ snapshots: [{ limitId: "codex", primary: { usedPercent } }] }),
      `${displayedRemaining}%`,
    );
    for (const window of ["primary", "secondary"] as const) {
      const report = { snapshots: [{
        limitId: "codex",
        primary: { usedPercent: 50 },
        secondary: { usedPercent: 50 },
        [window]: { usedPercent },
      }] };
      const bar = window === "primary"
        ? `${exhausted ? "▄" : "▙"}▄▄▄▄⠀⠀⠀⠀⠀`
        : `${exhausted ? "▀" : "▛"}▀▀▀▀⠀⠀⠀⠀⠀`;
      assert.equal(formatCodexUsageBar(report), bar);
      assert.equal(
        formatCodexUsageStatusline(report, testCtx),
        `<fg:accent>codex</fg> <bg:${background}><fg:dim>${bar}</fg></bg>`,
      );
    }
    assert.equal(
      formatCodexUsageBar({ snapshots: [{
        limitId: "codex",
        primary: { usedPercent },
        secondary: { usedPercent },
      }] }),
      exhausted ? "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀" : "▌⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    );
  }
});

test("rounds near-full quota to the nearest of twenty steps without an error background", () => {
  for (const [usedPercent, bar] of [[0, "██████████"], [1, "██████████"], [2.5, "██████████"], [2.51, "█████████▌"]] as const) {
    const report = { snapshots: [{
      limitId: "codex",
      primary: { usedPercent },
      secondary: { usedPercent },
    }] };
    assert.equal(formatCodexUsageBar(report), bar);
    assert.equal(
      formatCodexUsageStatusline(report, testCtx),
      `<fg:accent>codex</fg> <bg:userMessageBg><fg:dim>${bar}</fg></bg>`,
    );
  }
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
  assert.equal(formatResetCountdown(now + hourMs + 24 * minuteMs, now), "1.4h");
  assert.equal(formatResetCountdown(now + hourMs + 18 * minuteMs, now), "1.3h");
  assert.equal(formatResetCountdown(now + hourMs + 12 * minuteMs, now), "1.2h");
  assert.equal(formatResetCountdown(now + hourMs + 6 * minuteMs, now), "1.1h");
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
  assert.equal(nextResetCountdownDelayForRemainingMs(20 * hourMs), hourTenthMs);
  assert.equal(nextResetCountdownDelayForRemainingMs(hourMs), 1);
  assert.equal(
    nextResetCountdownDelayForRemainingMs(59 * minuteMs + 30 * secondMs),
    30 * secondMs + 1,
  );
  assert.equal(nextResetCountdownDelayForRemainingMs(59 * secondMs + 250), 251);
  assert.equal(nextResetCountdownDelayForRemainingMs(0), undefined);
});

test("uses the subdued bar background while keeping the countdown outside it", () => {
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
      "<fg:accent>codex</fg> <bg:userMessageBg><fg:dim>██████████</fg></bg> <fg:dim>6d</fg>",
    );
  } finally {
    Date.now = originalDateNow;
  }
});

test("uses an error background when either quota window is exhausted", () => {
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
              primary: { usedPercent: 100, resetAt: now + 5 * hourMs },
              secondary: { usedPercent: 50, resetAt: now + 7 * dayMs },
            },
          ],
        },
        testCtx,
      ),
      "<fg:accent>codex</fg> <bg:toolErrorBg><fg:dim>▄▄▄▄▄⠀⠀⠀⠀⠀</fg></bg> <fg:dim>5h/7d</fg>",
    );

    assert.equal(
      formatCodexUsageStatusline(
        {
          snapshots: [
            {
              limitId: "codex",
              primary: { usedPercent: 50 },
              secondary: { usedPercent: 100, resetAt: now + 7 * dayMs },
            },
          ],
        },
        testCtx,
      ),
      "<fg:accent>codex</fg> <bg:toolErrorBg><fg:dim>▀▀▀▀▀⠀⠀⠀⠀⠀</fg></bg> <fg:dim>7d</fg>",
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

test("all Codex models share the primary quota and codex status label", () => {
  const now = Date.parse("2026-05-28T00:00:00.000Z");
  const report = {
    snapshots: [{
      limitId: "codex",
      primary: { usedPercent: 50 },
      secondary: { usedPercent: 50 },
    }],
  };
  for (const model of [codexModel, otherCodexModel]) {
    assert.equal(formatCodexUsageStatusValue(report, model, now), "█████⠀⠀⠀⠀⠀");
    assert.equal(
      formatCodexUsageStatusline(report, testCtx, model),
      "<fg:accent>codex</fg> <bg:userMessageBg><fg:dim>█████⠀⠀⠀⠀⠀</fg></bg>",
    );
  }
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

test("formats exhausted primary windows with the full dual bar", () => {
  const now = Date.parse("2026-05-28T00:00:00.000Z");
  assert.equal(
    formatCodexUsageStatusValue(
      {
        snapshots: [
          {
            limitId: "codex",
            primary: { usedPercent: 100, resetAt: now + 5 * hourMs },
            secondary: { usedPercent: 50, resetAt: now + 7 * dayMs },
          },
        ],
      },
      now,
    ),
    "▄▄▄▄▄⠀⠀⠀⠀⠀ 5h/7d",
  );

  assert.equal(
    formatCodexUsageStatusValue(
      {
        snapshots: [
          {
            limitId: "codex",
            primary: { usedPercent: 100 },
            secondary: { usedPercent: 50, resetAt: now + 7 * dayMs },
          },
        ],
      },
      now,
    ),
    "▄▄▄▄▄⠀⠀⠀⠀⠀ 7d",
  );
});

test("uses the exhausted countdown and redraw boundary for rounded zero percent", () => {
  const now = Date.parse("2026-05-28T00:00:00.000Z");
  const report = { snapshots: [{
    limitId: "codex",
    primary: { usedPercent: 99.9, resetAt: now + 59 * secondMs + 250 },
    secondary: { usedPercent: 50, resetAt: now + 7 * dayMs },
  }] };
  assert.equal(formatCodexUsageStatusValue(report, now), "▄▄▄▄▄⠀⠀⠀⠀⠀ 59s/7d");
  assert.equal(nextResetCountdownDelayMs(report, now), 251);
});

test("schedules exhausted primary countdown redraws by the nearest reset label", () => {
  const now = Date.parse("2026-05-28T00:00:00.000Z");
  assert.equal(
    nextResetCountdownDelayMs(
      {
        snapshots: [
          {
            limitId: "codex",
            primary: {
              usedPercent: 100,
              resetAt: now + 59 * secondMs + 250,
            },
            secondary: { usedPercent: 50, resetAt: now + 7 * dayMs },
          },
        ],
      },
      now,
    ),
    251,
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
