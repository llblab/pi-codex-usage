# pi-codex-usage

Minimal Pi extension for showing primary ChatGPT Codex usage limits.

This repository is a minimal fork of [`narumiruna/pi-extensions/extensions/pi-codex-usage`](https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-codex-usage). It keeps the auth and quota-fetching path, but intentionally narrows the interface to the primary Codex 5-hour and weekly windows.

## Features

- `/codex-status` shows the primary Codex 5-hour and weekly limits
- Statusline output stays compact: `codex 64% 5h 62% wk`
- Additional returned buckets, including Spark-specific limits, are ignored
- Pi OpenAI Codex provider auth is used first
- Codex CLI app-server remains available as a fallback
- Results are cached briefly to avoid repeated backend calls

## Install

From npm:

```bash
pi install npm:@llblab/pi-codex-usage
```

From git:

```bash
pi install git:github.com/llblab/pi-codex-usage
```

## Usage

```text
/codex-status
/codex-status --refresh
/codex-status --timeout 30
```

Example notification:

```text
Codex usage
Usage page: https://chatgpt.com/codex/settings/usage

5h: 64% [██████░░░░] reset 13:57
week: 62% [██████░░░░] reset 14:37
```

Example statusline:

```text
codex 64% 5h 62% wk
```

## Auth

The extension tries usage sources in this order:

1. Pi's `openai-codex` provider auth
2. `codex app-server --listen stdio://`

OpenAI API keys are not ChatGPT Codex subscription auth and do not expose these quotas.

## Package

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## License

MIT. See [`LICENSE`](./LICENSE).
