# pi-codex-usage

Minimal Pi extension for showing the main ChatGPT Codex usage limits.

This repository is a minimal fork of [`narumiruna/pi-extensions/extensions/pi-codex-usage`](https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-codex-usage).

## What it shows

- The primary Codex 5-hour limit.
- The primary Codex weekly limit.
- A compact Pi statusline entry.

It intentionally does not display additional returned buckets such as Spark-specific limits.

## Install

```bash
pi install github:llblab/pi-codex-usage
```

Try locally from this repository:

```bash
pi -e /home/llb/.pi/agent/extensions/pi-codex-usage
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

The extension first uses Pi OpenAI Codex provider auth. If that is unavailable, it falls back to `codex app-server --listen stdio://`.

OpenAI API keys are not ChatGPT Codex subscription auth and do not expose these quotas.

## License

MIT. See [`LICENSE`](./LICENSE).
