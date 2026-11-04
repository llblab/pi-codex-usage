/** Domain: status lifecycle. Owns: local refresh, terminal redraw and optional Telegram row. Excludes: /fast command and request hook. */
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isFastEnabled, isFastEligibleModel } from "./fast.ts";
import { claimRefresh, isRefreshDue, nextRefreshAt, ownsRefreshClaim, publishRefresh, readState, type SharedState, MIN_ATTEMPT_GAP_MS } from "./usage-store.ts";
import { canReuseCachedReport, isFullyAvailableReport, isCodexUsageModel, isUsageUnavailable, type CodexUsageModel, type CodexUsageReport } from "./usage.ts";
import { appendFastStatus, formatReportBar, formatStatuslineLoading, formatStatuslineProblem, formatCodexUsageStatusline, nextResetCountdownDelayMs } from "./status-format.ts";
import { queryUsage, type QueryUsageResult } from "./query.ts";
import { codexUsageTelegramStatusLine, registerCodexUsageTelegramStatusLine } from "./telegram.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_TICK_MS = 30 * SECOND_MS;
const MIN_TICK_MS = SECOND_MS;
const TAKEOVER_JITTER_MS = 2 * SECOND_MS;
const STALE_REPORT_MAX_AGE_MS = HOUR_MS;
const PROVISIONAL_RETRY_MS = SECOND_MS;
const FULL_AVAILABILITY_CONFIRMATION_MS = 15 * SECOND_MS;
const LOADING_FRAME_MS = 30;
const REDRAW_BLINK_MS = 150;
const STATUS_KEY = "aa-codex-usage";
const DUAL_BAR_WIDTH = 10;

type TimeoutHandle = ReturnType<typeof setTimeout> & { unref?: () => void };
type PiModel = NonNullable<ExtensionContext["model"]>;
type CodexSharedState = SharedState<CodexUsageReport>;

export function createCodexUsageStatus(pi: ExtensionAPI) {
  const instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const stateDir = join(getAgentDir(), "tmp", "pi-codex-usage");
  let lastAttemptAt = 0;
  let inFlightRefresh: Promise<void> | undefined;
  let shown: { key?: string; report?: CodexUsageReport; updatedAt?: number } = {};
  let statuslineBlinkTimer: TimeoutHandle | undefined;
  let statuslineCountdownTimer: TimeoutHandle | undefined;
  let statuslineLoadingTimer: TimeoutHandle | undefined;
  let statuslineRefreshTimer: TimeoutHandle | undefined;
  let statuslineLoadingFrame = 0;
  let statuslineRequestId = 0;
  let unregisterTelegramStatusLine: (() => void) | undefined;
  let telegramStatusLineRegistration: Promise<void> | undefined;
  let fastModel: PiModel | undefined;
  let fastEnabled = false;
  let lastStatusText: string | undefined;
  let loadingModel: CodexUsageModel | undefined;

  const syncFast = (model: PiModel | undefined) => {
    fastModel = isFastEligibleModel(model) ? model : undefined;
    fastEnabled = fastModel !== undefined && isFastEnabled(fastModel);
  };
  const setCodexStatus = (ctx: ExtensionContext, text: string | undefined, model?: CodexUsageModel) => {
    lastStatusText = text;
    ctx.ui.setStatus(STATUS_KEY, text === undefined ? undefined : appendFastStatus(
      ctx, text,
      fastEnabled && model?.provider === fastModel?.provider && model?.id === fastModel?.id,
    ));
  };

  const loadState = () => readState<CodexUsageReport>(stateDir);

  const ensureTelegramStatusLineRegistered = () => {
    if (unregisterTelegramStatusLine || telegramStatusLineRegistration) return;
    telegramStatusLineRegistration = registerCodexUsageTelegramStatusLine(
      ({ activeModel }) => codexUsageTelegramStatusLine(shown.report, activeModel),
    )
      .then((unregister) => {
        unregisterTelegramStatusLine = unregister;
      })
      .finally(() => {
        telegramStatusLineRegistration = undefined;
      });
  };

  const clearStatuslineTimers = () => {
    if (statuslineBlinkTimer) clearTimeout(statuslineBlinkTimer);
    if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
    if (statuslineLoadingTimer) clearTimeout(statuslineLoadingTimer);
    if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
    statuslineBlinkTimer = undefined;
    statuslineCountdownTimer = undefined;
    statuslineLoadingTimer = undefined;
    statuslineRefreshTimer = undefined;
    loadingModel = undefined;
  };

  const stopStatuslineLoading = () => {
    if (statuslineLoadingTimer) clearTimeout(statuslineLoadingTimer);
    statuslineLoadingTimer = undefined;
    loadingModel = undefined;
  };

  const startStatuslineLoading = (
    ctx: ExtensionContext,
    model: CodexUsageModel | undefined,
  ) => {
    const modelChanged = loadingModel?.provider !== model?.provider || loadingModel?.id !== model?.id;
    loadingModel = model;
    if (statuslineLoadingTimer) {
      if (modelChanged) setCodexStatus(ctx, formatStatuslineLoading(ctx, statuslineLoadingFrame, model), model);
      return;
    }
    statuslineLoadingFrame = Math.random() < 0.5 ? 0 : DUAL_BAR_WIDTH * 2 - 1;
    const drawNextFrame = () => {
      try {
        setCodexStatus(ctx, formatStatuslineLoading(ctx, statuslineLoadingFrame, loadingModel), loadingModel);
        statuslineLoadingFrame += 1;
        statuslineLoadingTimer = setTimeout(
          drawNextFrame,
          LOADING_FRAME_MS,
        ) as TimeoutHandle;
        statuslineLoadingTimer.unref?.();
      } catch (error) {
        statuslineLoadingTimer = undefined;
        handleTimerError(error);
      }
    };
    drawNextFrame();
  };

  const clearUsageStatusline = (ctx: ExtensionContext) => {
    statuslineRequestId += 1;
    clearStatuslineTimers();
    shown = {};
    setCodexStatus(ctx, undefined);
  };

  const scheduleStatuslineRefresh = (ctx: ExtensionContext, delayMs: number) => {
    if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
    statuslineRefreshTimer = setTimeout(() => {
      void refreshCurrentCodexUsageStatusline(ctx, false).catch(
        handleAsyncTimerError,
      );
    }, delayMs) as TimeoutHandle;
    statuslineRefreshTimer.unref?.();
  };

  const scheduleStatuslineCountdown = (
    ctx: ExtensionContext,
    report: CodexUsageReport,
    model: CodexUsageModel | undefined,
  ) => {
    if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
    const delayMs = nextResetCountdownDelayMs(report, Date.now(), model);
    if (delayMs === undefined) {
      statuslineCountdownTimer = undefined;
      return;
    }
    statuslineCountdownTimer = setTimeout(() => {
      try {
        if (isCodexUsageModel(ctx.model)) {
          setCodexStatus(ctx, formatCodexUsageStatusline(report, ctx, model), model);
          scheduleStatuslineCountdown(ctx, report, model);
        }
      } catch (error) {
        handleTimerError(error);
      }
    }, delayMs) as TimeoutHandle;
    statuslineCountdownTimer.unref?.();
  };

  const setUsageStatusline = (
    ctx: ExtensionContext,
    report: CodexUsageReport,
    options: { blink: boolean; model: CodexUsageModel | undefined },
  ) => {
    if (statuslineBlinkTimer) clearTimeout(statuslineBlinkTimer);
    if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
    stopStatuslineLoading();
    statuslineBlinkTimer = undefined;
    statuslineCountdownTimer = undefined;
    const text = formatCodexUsageStatusline(report, ctx, options.model);
    if (options.blink) {
      setCodexStatus(ctx, formatStatuslineLoading(ctx, statuslineLoadingFrame, options.model), options.model);
      statuslineBlinkTimer = setTimeout(() => {
        try {
          setCodexStatus(ctx, text, options.model);
          scheduleStatuslineCountdown(ctx, report, options.model);
          statuslineBlinkTimer = undefined;
        } catch (error) {
          handleTimerError(error);
        }
      }, REDRAW_BLINK_MS) as TimeoutHandle;
      statuslineBlinkTimer.unref?.();
    } else {
      setCodexStatus(ctx, text, options.model);
      scheduleStatuslineCountdown(ctx, report, options.model);
    }
  };

  /** Draws the shared state; skips redraws when nothing changed. */
  const renderState = (
    ctx: ExtensionContext,
    state: CodexSharedState | undefined,
    model: CodexUsageModel | undefined,
    force: boolean,
  ) => {
    // Cached display data is not permission to query when the file is unreadable.
    if (!state && shown.report && Date.now() - (shown.updatedAt ?? 0) < STALE_REPORT_MAX_AGE_MS) {
      if (force) setUsageStatusline(ctx, shown.report, { blink: false, model });
      return;
    }
    const usable =
      state?.report &&
      state.updatedAt !== undefined &&
      Date.now() - state.updatedAt < STALE_REPORT_MAX_AGE_MS &&
      canReuseCachedReport(state.report, model)
        ? state.report
        : undefined;
    if (usable) {
      const key = `report:${state?.updatedAt}`;
      if (!force && shown.key === key) return;
      const blink = shown.report
        ? formatReportBar(shown.report, model) !== formatReportBar(usable, model)
        : false;
      shown = { key, report: usable, updatedAt: state?.updatedAt };
      setUsageStatusline(ctx, usable, { blink, model });
    } else if (state?.error) {
      const key = `error:${state.error}`;
      if (!force && shown.key === key) return;
      shown = { key };
      clearStatuslineTimers();
      setCodexStatus(ctx, formatStatuslineProblem(ctx, state.unavailable === true, model), model);
    } else {
      shown = { key: "loading" };
      startStatuslineLoading(ctx, model);
    }
  };

  /**
   * When this instance is due (leader after 1 minute, anyone after 90 seconds) it
   * claims leadership under the lock (owner and timestamp, so no other
   * instance is due), then fetches, then stamps the outcome. Failures are
   * published with a backoff so other instances do not pile on.
   */
  const refreshSharedState = (
    ctx: ExtensionContext,
    model: CodexUsageModel | undefined,
  ) => {
    if (inFlightRefresh) return inFlightRefresh;
    const promise = (async () => {
      const claim = claimRefresh(stateDir, instanceId);
      if (!claim) return;
      lastAttemptAt = Date.now();
      const result = await queryConfirmedUsage(
        ctx,
        model,
        loadState()?.report,
        () => ownsRefreshClaim(stateDir, claim),
      );
      if (!result) return;
      if (result.ok) {
        publishRefresh(stateDir, claim, result);
        return;
      }
      if (result.errors.some((error) => isStaleExtensionContextError(error.cause)))
        return;
      publishRefresh(stateDir, claim, {
        ok: false,
        error: result.errors.map((error) => error.message).join("; "),
        unavailable: isUsageUnavailable(result.errors),
        rateLimited: result.errors.some((error) =>
          error.message.includes("returned 429"),
        ),
      });
    })().finally(() => {
      if (inFlightRefresh === promise) inFlightRefresh = undefined;
    });
    inFlightRefresh = promise;
    return promise;
  };

  /**
   * Queries the usage. A first report claiming every window is completely
   * unused is provisional (providers can briefly emit zeroed windows while
   * initializing), so the claiming leader re-queries it every second for up to
   * 15 seconds before publishing.
   */
  const queryConfirmedUsage = async (
    ctx: ExtensionContext,
    model: CodexUsageModel | undefined,
    previous: CodexUsageReport | undefined,
    mayQuery: () => boolean,
  ): Promise<QueryUsageResult | undefined> => {
    const startedAt = Date.now();
    let result = await queryUsage(
      ctx,
      { timeoutMs: DEFAULT_TIMEOUT_MS },
      model,
      mayQuery,
    );
    if (previous && isFullyAvailableReport(previous, model)) return result;
    while (
      result?.ok &&
      isFullyAvailableReport(result.report, model) &&
      Date.now() - startedAt < FULL_AVAILABILITY_CONFIRMATION_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, PROVISIONAL_RETRY_MS));
      const retry = await queryUsage(
        ctx,
        { timeoutMs: DEFAULT_TIMEOUT_MS },
        model,
        mayQuery,
      );
      if (!retry) return undefined;
      if (!retry.ok) break;
      result = retry;
    }
    return result;
  };

  const nextTickDelayMs = (state: CodexSharedState | undefined) => {
    // Nothing to show yet (e.g. a claimed fetch is in flight): poll quickly.
    if (shown.key === "loading") return MIN_TICK_MS;
    const now = Date.now();
    const dueAt = Math.max(
      nextRefreshAt(state, instanceId, now),
      lastAttemptAt + MIN_ATTEMPT_GAP_MS,
    );
    const jitter =
      state?.owner === instanceId ? 0 : Math.random() * TAKEOVER_JITTER_MS;
    return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, dueAt - now + jitter));
  };

  const refreshCurrentCodexUsageStatusline = async (
    ctx: ExtensionContext,
    forceRender: boolean,
    model?: PiModel,
  ) => {
    try {
      const activeModel = model ?? ctx.model;
      const previousFast = fastEnabled;
      syncFast(activeModel);
      forceRender ||= previousFast !== fastEnabled;
      if (!isCodexUsageModel(activeModel)) {
        clearUsageStatusline(ctx);
        return;
      }

      const requestId = statuslineRequestId + 1;
      statuslineRequestId = requestId;
      let state = loadState();
      renderState(ctx, state, activeModel, forceRender);

      const now = Date.now();
      if (
        isRefreshDue(state, instanceId, now) &&
        now - lastAttemptAt >= MIN_ATTEMPT_GAP_MS
      ) {
        await refreshSharedState(ctx, activeModel);
        if (requestId !== statuslineRequestId) return;
        if (!isCodexUsageModel(ctx.model)) {
          clearUsageStatusline(ctx);
          return;
        }
        state = loadState();
        renderState(ctx, state, activeModel, false);
      }
      scheduleStatuslineRefresh(ctx, nextTickDelayMs(state));
    } catch (error) {
      if (isStaleExtensionContextError(error)) {
        clearStatuslineTimers();
        return;
      }
      throw error;
    }
  };

  ensureTelegramStatusLineRegistered();

  pi.on("session_start", (_event, ctx) => {
    syncFast(ctx.model);
    ensureTelegramStatusLineRegistered();
    if (isCodexUsageModel(ctx.model))
      void refreshCurrentCodexUsageStatusline(ctx, true).catch(
        handleAsyncTimerError,
      );
    else clearUsageStatusline(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (isCodexUsageModel(ctx.model))
      void refreshCurrentCodexUsageStatusline(ctx, true).catch(
        handleAsyncTimerError,
      );
    else clearUsageStatusline(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    syncFast(event.model);
    if (isCodexUsageModel(event.model)) {
      void refreshCurrentCodexUsageStatusline(ctx, true, event.model).catch(
        handleAsyncTimerError,
      );
    } else {
      clearUsageStatusline(ctx);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearUsageStatusline(ctx);
    unregisterTelegramStatusLine?.();
    unregisterTelegramStatusLine = undefined;
  });
  return {
    fastChanged(ctx: ExtensionContext, model: PiModel) {
      syncFast(model);
      if (lastStatusText !== undefined) setCodexStatus(ctx, lastStatusText, model);
      renderState(ctx, loadState(), model, true);
    },
  };
}


function handleAsyncTimerError(error: unknown): void {
  handleTimerError(error);
}

function handleTimerError(error: unknown): void {
  if (isStaleExtensionContextError(error)) return;
  throw error;
}

export function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ctx is stale");
}
