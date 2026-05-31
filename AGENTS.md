# Agent Notes

- `Statusline-first scope`: Keep this extension zero-configuration and focused on compact status surfaces.
  - Trigger: Considering commands, menus, persisted settings, or notification output.
  - Action: Prefer deleting the surface unless it is required for the optimistic TUI status widget or the optional `pi-telegram` `/start` status-line mirror.

- `Optimistic refresh`: Preserve the last good statusline bar during refresh and transient failures.
  - Trigger: Updating quota polling or error handling.
  - Action: Do not collapse the bar while a request is in flight; only show `n/a` or `error` after repeated failures or no usable quota.

- `Compact dual bar`: Encode the 5-hour and weekly quota windows in the ten-character separated-sextant bar.
  - Trigger: Changing statusline formatting.
  - Action: Keep a fixed-width `xxxxxxxxxx` bar where top sextants represent the 5-hour window and bottom sextants represent the weekly window, with 20 steps per window.

- `Weekly reset countdown`: Append the weekly reset countdown only when the secondary window exposes a reset time.
  - Trigger: Changing reset-time normalization or statusline refresh cadence.
  - Action: Keep `d` labels rounded upward in 144-minute day-tenth steps above 24h, show 24h..1h labels in upward-rounded 6-minute hour-tenth steps, keep `m`/`s` labels floored, and hold `0s` until a successful quota refresh reports the next window.
