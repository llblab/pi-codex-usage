/** Domain: Telegram adapter. Owns: optional provider registration. Excludes: quota state and terminal formatting. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isFastEnabled } from "./fast.ts";
import { isCodexUsageModel, isOpenAICodexModel, type CodexUsageReport } from "./usage.ts";
import { codexUsageStatusLabel, formatCodexUsageStatusValue } from "./status-format.ts";
const CODEX_USAGE_EXTENSION_ID = "@llblab/pi-codex-usage";
const TELEGRAM_STATUS_IMPORT_SPECIFIERS = [
  "@llblab/pi-telegram/status",
  new URL("../../pi-telegram/api/status.ts", import.meta.url).href,
];
type PiModel = NonNullable<ExtensionContext["model"]>;
type CodexUsageTelegramStatusModel = Pick<PiModel, "id" | "name" | "provider">;
type TelegramStatusLineProviderResult =
  { label: string; value: string } | undefined;
type TelegramStatusLineProvider = (ctx: {
  activeModel?: CodexUsageTelegramStatusModel;
}) => TelegramStatusLineProviderResult;
type TelegramStatusLineModule = {
  registerTelegramStatusLineProvider?: (
    provider: TelegramStatusLineProvider,
    options: { id: string },
  ) => () => void;
};

/** Read the selected model's preference at menu render time, not from the terminal cache. */
export function codexUsageTelegramStatusLine(
  report: CodexUsageReport | undefined,
  activeModel: CodexUsageTelegramStatusModel | undefined,
): TelegramStatusLineProviderResult {
  if (!activeModel || !isCodexUsageModel(activeModel)) return undefined;
  const value = report ? formatCodexUsageStatusValue(report, activeModel) : undefined;
  const fast = isOpenAICodexModel(activeModel) && isFastEnabled(activeModel);
  if (!value && !fast) return undefined;
  return { label: codexUsageStatusLabel(activeModel), value: value ? `${value}${fast ? " fast" : ""}` : "fast" };
}

async function importTelegramStatusLineModule(): Promise<
  TelegramStatusLineModule | undefined
> {
  for (const specifier of TELEGRAM_STATUS_IMPORT_SPECIFIERS) {
    try {
      const imported = (await import(specifier)) as TelegramStatusLineModule;
      if (typeof imported.registerTelegramStatusLineProvider === "function") {
        return imported;
      }
    } catch {
      // pi-telegram is optional; absence just disables the Telegram status line.
    }
  }
  return undefined;
}

export async function registerCodexUsageTelegramStatusLine(
  provider: TelegramStatusLineProvider,
): Promise<(() => void) | undefined> {
  const telegramStatus = await importTelegramStatusLineModule();
  return telegramStatus?.registerTelegramStatusLineProvider?.(provider, {
    id: CODEX_USAGE_EXTENSION_ID,
  });
}
