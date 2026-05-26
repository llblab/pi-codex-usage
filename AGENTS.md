# Agent Notes

- `Statusline-only scope`: Keep this extension zero-configuration and statusline-only.
  - Trigger: Considering commands, menus, persisted settings, or notification output.
  - Action: Prefer deleting the surface unless it is required for the optimistic status widget.

- `Optimistic refresh`: Preserve the last good statusline bar during refresh and transient failures.
  - Trigger: Updating quota polling or error handling.
  - Action: Do not collapse the bar while a request is in flight; only show `n/a` or `error` after repeated failures or no usable quota.

- `Compact dual bar`: Encode the 5-hour and weekly quota windows in the five-character separated-sextant bar.
  - Trigger: Changing statusline formatting.
  - Action: Keep a fixed-width `[xxxxx]` bar where top sextants represent the 5-hour window and bottom sextants represent the weekly window.
