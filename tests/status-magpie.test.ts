import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("Magpie lifecycle displays Codex quota, ticks resets, hides other models and preserves native-only Fast dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-magpie-status-"));
  try {
    await run(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
      import { join } from "node:path";
      const { default: extension } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
      const { codexUsageTelegramStatusLine: row } = await import(${JSON.stringify(new URL("../lib/telegram.ts", import.meta.url).href)});
      const dir = process.env.PI_CODING_AGENT_DIR;
      const stateDir = join(dir, "tmp", "pi-codex-usage");
      mkdirSync(stateDir, { recursive: true });
      const statePath = join(stateDir, "usage.json");
      const publish = data => writeFileSync(statePath, JSON.stringify({ ...data, owner: "other", claimedAt: Date.now(), updatedAt: Date.now() }));
      const model = { provider: "magpie", id: "codex/gpt-6.1-sol", name: "Codex" };
      const report = { snapshots: [{ limitId: "codex", secondary: { usedPercent: 33, resetAt: Date.now() + 2500 } }] };
      publish({ report });
      // Telegram reflects a manual priority preference; command/request handling stays native-only.
      const configPath = join(dir, "models.json");
      writeFileSync(configPath, JSON.stringify({ providers: { magpie: { modelOverrides: { [model.id]: { serviceTier: "priority" } } } } }));
      const originalConfig = readFileSync(configPath, "utf8");
      const handlers = new Map();
      let command;
      let status;
      const notices = [];
      globalThis.fetch = async () => { throw new Error("Cached lifecycle must not fetch quota"); };
      const ctx = { sessionManager: {}, model, ui: {
        theme: { fg: (_, text) => text, bg: (_, text) => text },
        setStatus: (_, text) => { status = text; },
        notify: text => notices.push(text),
      } };
      const emit = async (name, event = {}) => {
        for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
      };
      const select = async selected => {
        ctx.model = selected;
        await emit("model_select", { model: selected });
      };
      extension({
        on: (name, handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
        registerCommand: (name, options) => { assert.equal(name, "fast"); command = options.handler; },
      });
      try {
        await emit("session_start");
        assert.match(status, /^codex 67% [012]s$/);
        const telegramRow = row(report, model);
        assert.equal(telegramRow.label, "codex");
        assert.match(telegramRow.value, /^67% [012]s fast$/);
        const deadline = Date.now() + 4000;
        while (!status.endsWith(" 0s") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(status, "codex 67% 0s");
        await emit("session_tree");
        assert.equal(status, "codex 67% 0s");
        await command("", ctx);
        assert.equal(notices.pop(), "Fast mode is not supported for the current provider");
        assert.equal(readFileSync(configPath, "utf8"), originalConfig);
        for (const handler of handlers.get("before_provider_request")) {
          assert.equal(handler({ payload: { model: model.id } }, ctx), undefined);
        }
        for (const id of ["claude/claude-opus", "group/codex", "openai/gpt-6", "codex/"]) {
          const other = { ...model, id };
          await select(other);
          assert.equal(status, undefined);
          assert.equal(row(report, other), undefined);
        }
        const native = { ...model, provider: "openai", id: "gpt-native" };
        await select(native);
        assert.equal(status, "codex 67% 0s");
        await select({ ...model, id: "codex/gpt-6-astra" });
        assert.equal(status, "codex 67% 0s");
        assert.deepEqual(row(undefined, model), { label: "codex", value: "fast" });
        writeFileSync(configPath, "invalid json");
        await select(model);
        assert.equal(status, "codex 67% 0s");
        for (const [data, expected] of [
          [{ error: "No subscription", unavailable: true }, "codex n/a"],
          [{ error: "Network failure" }, "codex error"],
        ]) {
          publish(data);
          await select(model);
          assert.equal(status, expected);
        }
        publish({});
        await select(native);
        assert.match(status, /^codex /);
        await select(model);
        // Both native and proxy models retain the same label while loading.
        assert.match(status, /^codex /);
        await select({ ...model, id: "claude/claude-opus" });
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(status, undefined);
      } finally {
        await emit("session_shutdown");
        assert.equal(status, undefined);
      }
    `], { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, timeout: 15_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
