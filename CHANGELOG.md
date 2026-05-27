# Changelog

- `0.3.5` Refined the compact statusline bar with quadrant glyphs, darker bar coloring, and blink-on-segment-change behavior. Impact: Codex quota changes are easier to notice while routine refreshes stay visually stable.
- `0.3.4` Added package banner metadata and README hero image. Impact: Pi/package listings can show the Codex Usage banner while npm packages include the image asset.
- `Fork baseline` Imported `extensions/pi-codex-usage` from `narumiruna/pi-extensions` as a standalone `@llblab/pi-codex-usage` package. Impact: the extension can be installed and maintained independently.
- `Minimal statusline` Removed command-driven report output and narrowed the extension to a zero-configuration statusline widget. Impact: runtime behavior is automatic while `openai-codex` is active.
- `Primary quota focus` Ignored additional returned buckets such as Spark-specific limits. Impact: the statusline only represents primary Codex 5-hour and weekly quota windows.
- `Dual quota bar` Replaced textual percentages with a fixed-width separated-sextant bar. Impact: both 5-hour and weekly remaining quota are encoded in five statusline characters.
- `Optimistic refresh` Kept the last good bar during refresh and transient failures, with a short successful-redraw blink. Impact: the footer no longer shifts or collapses during polling.
