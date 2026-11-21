import { checkRedeploy, type RedeployCheck } from "./api";
import { state, notify, runningKind } from "./state";

// Proactively asks "is there code on this game's branch that isn't deployed
// yet?" (redeploy.sh --check) so the operator is told instead of having to go
// looking. Only the selected game is checked — each check is a doctl call plus
// a couple of git fetches. Redeploying never requires an answer of "behind";
// this only decides whether to nudge.

// How often to re-check the selected game while the app stays open, and how
// stale an answer may be before regaining window focus triggers a fresh one.
const POLL_MS = 10 * 60 * 1000;
const FOCUS_STALE_MS = 5 * 60 * 1000;

// The newest commit the operator dismissed the banner for, per game. A newer
// commit brings the banner back; in-memory only, so a restart re-nudges.
const dismissedLatest = new Map<string, string>();

export function dismissCodeUpdate(appName: string, latest: string): void {
  dismissedLatest.set(appName, latest);
  notify();
}

export function isCodeUpdateDismissed(appName: string, latest: string): boolean {
  return dismissedLatest.get(appName) === latest;
}

// The selected game's latest result, or null when there isn't one (not
// checked yet, not deployed, or the check failed outright).
export function currentCodeCheck(): RedeployCheck | null {
  const c = state.codeCheck;
  return c && c.appName === state.appName ? c.result : null;
}

// Re-runs the check for the selected game. Safe to call freely: it does
// nothing unless the game has a deployed app and no script is mid-run (a run
// in flight is about to change the answer anyway).
export async function refreshCodeCheck(): Promise<void> {
  const appName = state.appName;
  if (!appName || !state.opsDir || !state.deployConfFound || !state.status?.appExists || runningKind(appName)) {
    state.codeCheck = null;
    notify();
    return;
  }

  const previous = state.codeCheck?.appName === appName ? state.codeCheck : null;
  state.codeCheck = {
    appName,
    checking: true,
    result: previous?.result ?? null,
    error: "",
    checkedAt: previous?.checkedAt ?? 0,
  };
  notify();

  let next: NonNullable<typeof state.codeCheck>;
  try {
    const result = await checkRedeploy(state.opsDir, appName);
    next = { appName, checking: false, result, error: "", checkedAt: Date.now() };
  } catch (err) {
    // Keep the last good answer: one failed poll (offline, rate limit) isn't a
    // reason to retract a banner that was true a moment ago.
    next = {
      appName,
      checking: false,
      result: previous?.result ?? null,
      error: err instanceof Error ? err.message : String(err),
      checkedAt: Date.now(),
    };
  }
  // The operator may have moved to another game while this was running.
  if (state.appName !== appName) return;
  state.codeCheck = next;
  notify();
}

// Call once at startup (see main.ts).
export function startCodeCheckPolling(): void {
  setInterval(() => {
    if (state.appName) void refreshCodeCheck();
  }, POLL_MS);
  window.addEventListener("focus", () => {
    const c = state.codeCheck;
    if (state.appName && c && c.appName === state.appName && !c.checking && Date.now() - c.checkedAt > FOCUS_STALE_MS) {
      void refreshCodeCheck();
    }
  });
}
