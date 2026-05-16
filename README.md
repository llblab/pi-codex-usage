# 📊 pi-codex-usage — Codex Usage Status for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-codex-usage)](https://www.npmjs.com/package/@narumitw/pi-codex-usage) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-codex-usage` is a native [Pi coding agent](https://pi.dev) extension that adds `/codex-status`, a command for showing ChatGPT Codex subscription usage from inside Pi.

Use it when you want a quick Codex-style usage summary without leaving Pi or requiring Codex CLI to be installed.

## ✨ Features

- Adds a `/codex-status` command to Pi.
- Shows Codex plan, 5-hour and weekly usage windows, reset times, and credits.
- Displays additional usage buckets when the Codex backend returns them.
- Uses Pi's own OpenAI Codex subscription auth first.
- Falls back to `codex app-server --listen stdio://` only when Pi auth is unavailable.
- Caches results briefly to avoid repeatedly calling the backend.
- Supports `--refresh` to bypass the in-memory cache.
- Works as an independently installable npm Pi extension package.

## 📦 Install

```bash
pi install npm:@narumitw/pi-codex-usage
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-codex-usage
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-codex-usage
```

## 🚀 Usage

```text
/codex-status
/codex-status --refresh
/codex-status --timeout 30
```

Example output:

```text
Codex usage
Source: Pi auth direct
Plan: Plus

codex:
  5h limit: [█████████████░░░░░░░] 64% left (36% used, resets 13:57)
  weekly limit: [████████████░░░░░░░░] 62% left (38% used, resets 14:37)
  Credits: not enabled
```

## 🔐 Auth behavior

`pi-codex-usage` tries usage sources in this order:

1. Pi's `openai-codex` provider auth through the Pi extension API.
2. Codex CLI app-server fallback when Pi auth cannot provide usable subscription auth.

This means Codex CLI is optional. Users who already use a Pi OpenAI Codex model or have logged in to Pi with ChatGPT Plus/Pro subscription auth can use the direct Pi-auth path.

The extension does not read Pi or Codex auth files directly, and it does not expose bearer tokens in error messages.

## 🚧 Limitations

- OpenAI API keys are not ChatGPT Codex subscription auth and do not expose this quota.
- Usage data is a snapshot, not a live statusline. Results are cached for five minutes unless `--refresh` is used.
- The fallback path requires Codex CLI to be installed and logged in.

## 🗂️ Package layout

```txt
extensions/pi-codex-usage/
├── src/
│   └── codex-usage.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/codex-usage.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, Codex usage, Codex status, ChatGPT subscription usage, rate limits, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
