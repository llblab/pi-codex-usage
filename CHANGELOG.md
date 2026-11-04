# Changelog

## Unreleased

- Added a local Codex subscription monitor for Magpie's `codex/…` models, with the same `codex` label as native providers throughout terminal and optional Telegram output. Quota/reset data still comes from the existing local Pi subscription auth / Codex CLI source order; it is not attributed to Magpie's routed account. Other Magpie namespaces stay hidden, and proxy credentials never enter quota auth. Fast command dispatch, terminal suffixes and request adaptation remain native-provider-only; Telegram continues to reflect the active model's priority preference, including manually configured Magpie preferences.
- Centralized display-only proxy eligibility in a provider/prefix mapping so similar providers can reuse status, countdowns and shared refresh without broadening native auth or Fast command/request handling. Added regression coverage for mixed-provider sharing, model changes, countdowns, loading labels, credential selection, Telegram priority preferences and native-only Fast dispatch.

## 0.13.2: Empty Quota Bar Hotfix

- Aligned quota bars with rounded remaining percentages: when either window rounds to `0%`, its final segment disappears and the whole dual bar uses the error background, while the other half retains its quota. The 5-hour reset countdown follows the same zero boundary; near-full quota still rounds to the nearest 5% step.
- Release verification now tolerates up to approximately 30 minutes of npm registry processing before checking the published package identity and creating the GitHub Release.

## 0.13.1: Windows Codex CLI Fallback

- The Codex CLI fallback now starts on Windows. When npm installs Codex behind a `codex.cmd` shim that a shell-free `spawn` cannot launch, the extension resolves the native `codex.exe` from PATH or from the npm platform package and starts it directly, so fallback quota stays available when the primary endpoint fails. Non-Windows platforms keep plain PATH lookup, and the helper window is hidden.
- Added Linux and Windows GitHub Actions validation for the full release check suite.

## 0.13.0: OpenAI Subscription Provider Support

- Added `openai` alongside `openai-codex` for `/fast`, request priority adaptation, terminal status and the optional Telegram row. Fast preferences remain isolated by provider/model, including identical model IDs. Both providers share the existing Codex subscription quota stream. Pi subscription OAuth under `openai` now fetches quota directly without requiring the legacy provider; `openai` API-key auth is skipped and the Codex CLI fallback is preserved.

## 0.12.1: Telegram Fast Status

- The optional Telegram status row now appends lowercase ` fast` for the active Codex model, or shows `fast` alone when quota is unavailable. It rereads the per-model preference at menu render time, so toggles, model changes and manual edits do not wait for quota refresh. Quota polling, auth, request adaptation and terminal behavior are unchanged; isolated tests cover enabled/disabled state, model/provider changes and unreadable configuration.

## 0.12.0: Shared Fast Mode and Pi 1.0 Baseline

- Requires Pi ≥1.0.0 across the coding-agent, AI and agent-core peers; previous hosts are outside this release's compatibility contract.
- Added argument-free, persistent per-model `/fast` for the `openai-codex` provider with no model-ID allowlist or Fast-specific auth gate. `@llblab/pi-command-fast@^0.1.0` coordinates one command alongside Claude Usage across duplicate library copies, separate sessions and reloads; generic JSONC editing moved to that normal library. Enabled stores only `serviceTier: "priority"`; OFF removes the property.
- Enabled Fast adds `service_tier: "priority"` to eligible Codex requests only when no tier is already present, and appends `fast` to the existing terminal status in the same dim theme color as its reset countdown, with immediate redraw and no success notification. State follows model selection and survives restart; the loading renderer tracks the newly selected model so an old timer cannot restore its previous suffix. Quota coordination and the Telegram status row are unchanged.
- Split the monolithic entrypoint into an explicit domain DAG under `lib/`. `index.ts` only re-exports the composition root in `lib/extension.ts` and previous public contracts. The quota store, provider transport, normalized report, status lifecycle/format, Telegram adapter, and Fast override have separate owners; tests now live in `tests/` with domain-matched names.

## 0.11.0: Shared Quota Refresh

- Coordinated polling across Pi instances through one `~/.pi/agent/tmp/pi-codex-usage/usage.json`: the leader refreshes every 60 seconds, followers normally read every 30 seconds, and leadership becomes eligible for takeover after 90 seconds without a touch. Failure backoff is shared, the last successful report stays visible for up to an hour, and provisional full-availability confirmation runs only in the refreshing instance.
- Made the JSON authoritative for request admission and fenced publication using the on-disk owner, claim generation, and lease. A non-waiting OS-backed SQLite mutex serializes claiming and publication; lock or claim-write failures deny requests, and late results cannot overwrite a successor. **Upgrade:** close all old Pi instances before starting updated ones; do not mix locking protocols or remove the mutex file while instances run.
- **Breaking:** Removed Spark-specific quotas, labels, and source priority. All Codex models now use the primary `codex` quota; additional buckets and legacy per-bucket caches are ignored without migration. Dual-bar rendering, loading animation, reset countdowns, Business credit usage, Pi auth, and the Codex app-server fallback are preserved.

## 0.10.1: Softer Quota Bar

- Changed the normal and loading dual-quota bar background from `selectedBg` to the softer themed `userMessageBg`; exhausted quotas still use `toolErrorBg`. The bar is less prominent across dark and light themes without altering quota values or countdowns.

## 0.10.0: Business Credit Usage

- Added Business-account credit usage support for responses that do not expose Codex rate-limit windows. Impact: the statusline now shows rounded remaining credit percentage and an optional reset countdown while preserving existing rate-limit displays when both forms are available.
- Scheduled credit reset countdown redraws at their exact display boundaries and retained credits-only reports in the active cache. Impact: credit status remains locally responsive between API refreshes without displacing model-specific quota windows.

## 0.9.4: Responsive Quota Polling

- Increased the automatic Codex quota refresh interval from 30 to 60 seconds. Impact: status values remain responsive down to the locally rendered seconds countdown while reducing repeated OpenAI requests, especially when several Pi instances are open.

## 0.9.3: Trusted Release Automation

- Added tag-gated release automation with exact package/lock/tag identity checks, full package validation, npm Trusted Publisher provenance, public registry verification, and workflow-owned GitHub Release creation through `.github/workflows/release.yml`.
- Normalized nullable provider headers into the string-only request header contract, preserving compatibility with current Pi model-registry types while omitting intentionally removed headers.

## 0.9.1: Clear Weekly Quota Status

- Replaced the unified single-window bar with an explicit remaining-quota percentage. Impact: weekly-only OpenAI responses now render as compact text such as `codex 67% 7d`, making both the remaining quota and reset time immediately readable without decoding a bar.
- Preserved the classic dual-tier bar for responses that still expose both 5-hour and weekly windows. Impact: older or account-specific server response shapes retain the dense two-limit display while the status adapts directly to available information.

## 0.9.0: Adaptive Weekly Quota Bar

- Added server-driven quota-window display selection. Impact: responses containing both 5-hour and weekly windows keep the classic dual-tier bar, while responses containing only the new weekly window use all 40 bar steps as one unified quota scale instead of leaving one tier empty.
- Added single-window reset countdown and redraw scheduling. Impact: the weekly reset time remains visible and updates at the correct countdown boundaries regardless of whether OpenAI returns the weekly limit as the primary or secondary window.
- Extended provisional full-quota stabilization to single-window responses. Impact: transient 0%-used weekly reports remain behind the loading indicator until confirmed, matching the existing dual-window safety behavior.

## 0.8.2: Quota Loading Hotfix

- Replaced the static empty request placeholder with fixed-width upper and lower markers that move in opposite directions through their respective quota bars, reverse at the ends, and randomly start from either mirrored endpoint phase, using the normal themed bar background. Impact: motion distinguishes startup and model-bucket loading from 100% available quota while preserving the dual-window visual language.
- Kept the last usable active-bucket report visible while refreshing, including when returning from another model bucket, and stabilized first reports claiming both windows are completely unused for 15 seconds with one-second retries. Impact: routine polling remains visually stable while transient provider initialization values stay behind the loader instead of appearing as false 100% availability.

## 0.8.1: Stale Context Hotfix

- Fixed stale extension context crashes from delayed statusline timers after Pi session replacement or reload. Impact: timers now ignore stale `ctx` failures instead of letting issue #1 crash Pi after idle/session lifecycle changes.
- Fixed Codex/Spark refresh state to key in-flight usage lookups by active quota bucket and only reuse cached reports that contain the active bucket. Impact: switching between regular Codex and Spark no longer temporarily renders the active bucket as unavailable because of a stale request/cache.
- Fixed Spark failure labels. Impact: Spark unavailable/error states now render with the `spark` label instead of falling back to `codex`.
- Added regression coverage for active-bucket cache reuse and stale extension context error detection.

## 0.8.0: Spark Model Usage Status

- Added active-bucket status support for `GPT-5.3-Codex-Spark`. Impact: selecting the Spark Codex subscription model now shows the parallel Spark rate-limit bucket with a `spark` label, while regular Codex models keep the existing `codex` bucket/status behavior.
- Added parsing for backend `additional_rate_limits`, including the Spark `GPT-5.3-Codex-Spark` / `codex_bengalfox` limit. Impact: Spark quota can be shown from the same Pi-auth usage response path as normal Codex quota instead of relying only on app-server fallback.

## 0.7.0: Exhausted Quota Visibility

- Added exhausted-quota warning background for the statusline quota bar. Impact: when either the 5-hour or weekly Codex window has 0% remaining, the bar keeps its shape but switches from the selected background to the error background for faster visual detection.
- Added exhausted-primary countdown display for cases where the 5-hour Codex window has 0% remaining and exposes a reset time. Impact: the statusline keeps the normal ten-cell dual bar and appends `<5-hour-reset>/<weekly-reset>` countdowns, so operators can see both how long to wait for short-window recovery and how much weekly quota remains.
- Fixed quota-bar rounding so a truly empty segment state is shown only when a quota window has 0% remaining, while any positive sub-5% remainder still renders as one visible step. Impact: the statusline now distinguishes exhausted Codex limits from tiny remaining quota without changing normal round-to-nearest behavior elsewhere.

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
