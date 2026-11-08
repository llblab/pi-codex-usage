import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const extensionName = basename(fileURLToPath(new URL("..", import.meta.url)));
const claude = extensionName === "pi-claude-usage";

const scenarios = ["auth", "success", "failure", "same-owner", "unwritable", "display"];
if (!claude) scenarios.push("retry");

for (const scenario of scenarios) {
  test(`disk leadership fences the ${scenario} boundary`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-leadership-"));
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    const script = `
      import assert from "node:assert/strict";
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const claude = ${claude};
      const scenario = ${JSON.stringify(scenario)};
      const statePath = join(process.env.PI_CODING_AGENT_DIR, "tmp", ${JSON.stringify(extensionName)}, "usage.json");
      const successorReport = claude
        ? { primary: { usedPercent: 60 }, secondary: { usedPercent: 70 } }
        : { snapshots: [{ limitId: "codex", primary: { usedPercent: 60 }, secondary: { usedPercent: 70 } }] };
      let successorBytes;
      const replaceClaim = () => {
        const old = JSON.parse(readFileSync(statePath, "utf8"));
        successorBytes = JSON.stringify({
          owner: scenario === "same-owner" ? old.owner : "successor",
          claimId: "successor-generation",
          claimedAt: Date.now(), updatedAt: Date.now(), report: successorReport,
        });
        writeFileSync(statePath, successorBytes);
      };
      let calls = 0;
      let authCalls = 0;
      globalThis.fetch = async () => {
        calls++;
        replaceClaim();
        const used = scenario === "retry" ? 0 : 10;
        return new Response(JSON.stringify(claude
          ? { five_hour: { utilization: used }, seven_day: { utilization: used } }
          : { rate_limit: { primary_window: { used_percent: used }, secondary_window: { used_percent: used } } }
        ), { status: scenario === "failure" ? 429 : 200 });
      };
      if (scenario === "unwritable") mkdirSync(statePath, { recursive: true });
      if (scenario === "display") {
        mkdirSync(join(statePath, ".."), { recursive: true });
        writeFileSync(statePath, JSON.stringify({
          owner: "other", claimId: "display-generation", claimedAt: Date.now(),
          updatedAt: Date.now(), report: successorReport,
        }));
      }
      let cliCalls = 0;
      childProcess.spawn = () => { cliCalls++; throw new Error("CLI disabled in test"); };
      syncBuiltinESMExports();
      const module = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
      const handlers = new Map();
      let status;
      const model = { provider: claude ? "anthropic" : "openai-codex", id: "test", name: "Test" };
      const ctx = {
        model,
        ui: {
          theme: { fg: (_, value) => value, bg: (_, value) => value },
          setStatus: (_, value) => { status = value; },
        },
        modelRegistry: {
          getAvailable: () => [model], getAll: () => [model],
          getApiKeyAndHeaders: async () => {
            authCalls++;
            if (scenario === "auth") replaceClaim();
            return claude
              ? { ok: true, apiKey: "sk-ant-oat-test" }
              : {
                  ok: true,
                  apiKey: "test-token",
                  headers: {
                    Authorization: "Bearer test-token",
                    "ChatGPT-Account-Id": "account-fixture",
                  },
                };
          },
        },
      };
      module.default({ on: (name, handler) => handlers.set(name, handler), registerCommand: () => {} });
      try {
        handlers.get("session_start")({}, ctx);
        if (scenario === "display") {
          const format = claude ? module.formatClaudeUsageStatusValue : module.formatCodexUsageStatusValue;
          const expected = (claude ? "claude" : "codex") + " " + format(successorReport);
          assert.equal(status, expected);
          renameSync(statePath, statePath + ".saved");
          mkdirSync(statePath);
          handlers.get("session_tree")({}, ctx);
          await new Promise(resolve => setTimeout(resolve, 100));
          assert.equal(status, expected);
          assert.equal(authCalls, 0);
          assert.equal(calls, 0);
        } else if (scenario === "unwritable") {
          await new Promise(resolve => setTimeout(resolve, 100));
          assert.equal(authCalls, 0);
          assert.equal(calls, 0);
        } else {
          const format = claude ? module.formatClaudeUsageStatusValue : module.formatCodexUsageStatusValue;
          const expected = (claude ? "claude" : "codex") + " " + format(successorReport);
          const deadline = Date.now() + 4000;
          while (status !== expected && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 20));
          assert.equal(status, expected);
          assert.equal(calls, scenario === "auth" ? 0 : 1);
          assert.equal(authCalls, 1);
          assert.equal(readFileSync(statePath, "utf8"), successorBytes);
        }
        assert.equal(cliCalls, 0);
        console.log("leadership fenced");
      } finally {
        handlers.get("session_shutdown")({}, ctx);
      }
    `;
    try {
      const { stdout } = await run(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", script],
        { env: { ...process.env, PI_CODING_AGENT_DIR: dir, CODEX_HOME: codexHome }, timeout: 15_000 },
      );
      assert.match(stdout, /leadership fenced/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
