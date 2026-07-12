# Agent Notes

- `Statusline-first scope`: Keep this extension zero-configuration and focused on compact status surfaces.
  - Trigger: Considering commands, menus, persisted settings, or notification output.
  - Action: Prefer deleting the surface unless it is required for the optimistic TUI status widget or the optional `pi-telegram` `/start` status-line mirror.

- `Optimistic refresh`: Preserve the last good statusline bar during refresh and transient failures.
  - Trigger: Updating quota polling or error handling.
  - Action: Do not collapse the bar while a request is in flight; only show `n/a` or `error` after repeated failures or no usable quota.

- `Adaptive compact status`: Match the status representation to the server-provided quota windows.
  - Trigger: Changing statusline formatting.
  - Action: When both windows exist, keep the classic dual bar with 20 top steps for the 5-hour window and 20 bottom steps for the weekly window. When only one weekly window exists, show its rounded remaining percentage directly instead of using a bar.

- `Weekly reset countdown`: Append the weekly reset countdown whenever the available weekly window exposes a reset time.
  - Trigger: Changing reset-time normalization or statusline refresh cadence.
  - Action: Treat the secondary window as weekly in dual-window responses and the sole window as weekly in single-window responses. Keep `d` labels rounded upward in 144-minute day-tenth steps above 24h, show 24h..1h labels in upward-rounded 6-minute hour-tenth steps, keep `m`/`s` labels floored, and hold `0s` until a successful quota refresh reports the next window.
