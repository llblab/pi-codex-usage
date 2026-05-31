# Changelog

## Unreleased

## 0.6.0: Telegram Status Integration

- Added optional `pi-telegram` status-menu integration through the public Telegram status-line provider API. When `pi-telegram` is available and the active model is an OpenAI Codex subscription model, the `/start` menu status text now includes `codex: <value>` using the same compact quota bar and reset countdown value as the terminal statusline. Impact: Telegram operators can see Codex quota/reset state in the main control menu without any extra configuration, while non-Codex models and missing `pi-telegram` installs stay unchanged.

## 0.5.2: Sub-Day Reset Countdown And JPEG Banner

- Refined the weekly reset countdown below 24 hours to use upward-rounded 6-minute hour-tenth steps (`24h`, `23.7h`, `20.1h`, `20h`, `19.9h`, …, `1h`) instead of coarse whole-hour floors. Impact: the statusline gives more useful sub-day reset timing without growing wider than one decimal place.
- Replaced the package/banner artwork from PNG to JPEG and updated package metadata plus README image references. Impact: the package ships the new compressed banner asset consistently across npm and Pi extension listings.

## 0.5.1: Non-Codex Bucket Hotfix

- Fixed non-Codex app-server quota buckets so Spark-only or unrelated limits are ignored instead of being displayed as Codex quota.

## 0.5.0: Weekly Reset Countdown

- Added refresh request coalescing so repeated statusline events share one quota lookup instead of spawning parallel provider/fallback requests. Impact: transient failures and busy session-tree updates no longer amplify Codex usage polling work.
- Hardened quota parsing and failure classification by accepting array-shaped app-server rate limits, treating `n/a` as valid only when every failed source reports an unavailable auth/plan/quota state, and adding `node:test` coverage for normalization, bar formatting, and failure classification. Impact: real fallback/runtime failures are surfaced as `error` while expected unavailable states still show `n/a`.
- Added a weekly reset countdown after the quota bar when the secondary Codex window exposes a reset timestamp, including 144-minute day-tenth steps, exact boundary redraw scheduling, hour/minute/second bucket formatting, and `0s` holdover until the next successful quota refresh. Impact: the statusline now shows both remaining quota and time until the weekly bucket cycles.

## 0.4.1: Stable Startup Bar

- Fixed the initial empty statusline bar to use ten non-trimmed blank glyph cells through the same formatting path as the populated quota bar. Impact: the footer background stays at ten cells during startup before the first quota values arrive.

## 0.4.0

- Expanded the dual statusline bar to ten glyphs with 20 steps per quota window, moved its status key near the start of the footer status order, and draws the bar on the themed selected background. Impact: 5-hour and weekly limits now move in 5% increments for 40 total discrete points while empty cells no longer blend into the terminal background.

## 0.3.5

- Refined the compact statusline bar with quadrant glyphs, darker bar coloring, and blink-on-segment-change behavior. Impact: Codex quota changes are easier to notice while routine refreshes stay visually stable.

## 0.3.4

- Added package banner metadata and README hero image. Impact: Pi/package listings can show the Codex Usage banner while npm packages include the image asset.

## Fork baseline

- Imported `extensions/pi-codex-usage` from `narumiruna/pi-extensions` as a standalone `@llblab/pi-codex-usage` package. Impact: the extension can be installed and maintained independently.
- Removed command-driven report output and narrowed the extension to a zero-configuration statusline widget. Impact: runtime behavior is automatic while `openai-codex` is active.
- Ignored additional returned buckets such as Spark-specific limits. Impact: the statusline only represents primary Codex 5-hour and weekly quota windows.
- Replaced textual percentages with a fixed-width separated-sextant bar. Impact: both 5-hour and weekly remaining quota are encoded in five statusline characters.
- Kept the last good bar during refresh and transient failures, with a short successful-redraw blink. Impact: the footer no longer shifts or collapses during polling.
