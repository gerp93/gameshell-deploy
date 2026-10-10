import type { DeployConf, GameStatus, LogLine, PreflightResult, RedeployCheck, StatusResult } from "./api";

// Plain module-level state — no state-management library, this app only
// has a handful of panels.
export const state = {
  opsDir: "",
  appName: "",
  // The games/ directory listing — shared so any panel that changes it on
  // disk (creating a new deploy.conf, deleting a game) can trigger a
  // refetch via appPanel's exported refreshGames() without reaching into
  // the sidebar component directly.
  games: [] as string[],
  deployConfFound: false,
  deployConf: null as DeployConf | null,
  preflight: null as PreflightResult | null,
  status: null as StatusResult | null,
  // Every game's Digital Ocean status, for the sidebar tags (see
  // appPanel.refreshAllStatuses). The selected game's tag uses `status`
  // above instead, which a deploy or teardown updates immediately.
  gameStatuses: [] as GameStatus[],
  activeTab: "action" as "config" | "action",
  prereqExpanded: false,
  // true while chooseApp() is loading a newly-selected game's deploy.conf +
  // DO status — both hit disk/doctl and can take a couple of seconds.
  loadingGame: false,
  // Whether the selected game's branch has code that isn't deployed yet (see
  // codeCheck.ts). null until a check has been started for the selected game.
  codeCheck: null as CodeCheckState | null,
  // Which form the Manage tab shows for a deployed game (see manageMode()).
  // Defaults to the safe one and is put back to it whenever the game changes
  // or a teardown finishes, so Teardown is never what you land on.
  manageMode: "redeploy" as "redeploy" | "teardown",
};

// The latest "is there new code to redeploy?" answer for one game. result
// keeps the previous answer while a re-check is in flight, so a banner doesn't
// flicker away and back on every poll.
export interface CodeCheckState {
  appName: string;
  checking: boolean;
  result: RedeployCheck | null;
  error: string;
  // Date.now() when the last check finished; 0 if none has.
  checkedAt: number;
}

// --- per-game run tracking -------------------------------------------------
//
// Deploy/teardown can run for multiple games at once (the Go side tracks one
// process per app name — see scriptrunner.go), so log output and "is a
// script running for this game" both need to be keyed by app name rather
// than a single global flag. Kept separate per kind too, not just per game:
// a game's Deploy history and Teardown history are independent logs, not one
// merged stream. There's still only one Deploy/Teardown panel in the DOM; it
// just re-points at whichever game's GameRun the sidebar has selected (see
// logPane.ts).

export type RunKind = "create" | "delete" | "redeploy";

export interface GameRun {
  running: boolean;
  lines: LogLine[];
  lastExit?: { code: number; err?: string };
  // Label/value pairs describing what the run was launched with (region,
  // tier, ssh key…), shown next to the log so a run you switch back to
  // explains itself. Never holds secrets — the credential fields are
  // cleared the moment a run starts and are never recorded here.
  params?: Array<[string, string]>;
}

const MAX_LOG_LINES = 4000;
const gameRuns: Record<RunKind, Map<string, GameRun>> = { create: new Map(), delete: new Map(), redeploy: new Map() };

export function getGameRun(kind: RunKind, appName: string): GameRun {
  const map = gameRuns[kind];
  let run = map.get(appName);
  if (!run) {
    run = { running: false, lines: [] };
    map.set(appName, run);
  }
  return run;
}

export function appendGameRunLine(kind: RunKind, line: LogLine): void {
  const run = getGameRun(kind, line.appName);
  run.lines.push(line);
  if (run.lines.length > MAX_LOG_LINES) {
    run.lines.splice(0, run.lines.length - MAX_LOG_LINES);
  }
}

// Wipes a kind's buffered log/exit/params for a game — called both when a
// fresh run of that same kind starts (so it doesn't open showing the
// previous run's tail) and, from the *other* kind's finish handler, when
// that kind's history no longer describes anything real: a successful
// deploy means whatever teardown history existed was for a deployment that
// no longer exists, and vice versa. Doesn't touch `running`, since this is
// never called on a run that's actually in flight.
export function clearGameRun(kind: RunKind, appName: string): void {
  const run = getGameRun(kind, appName);
  run.lines = [];
  run.lastExit = undefined;
  run.params = undefined;
}

export function isGameRunning(kind: RunKind, appName: string): boolean {
  return getGameRun(kind, appName).running;
}

// True after this kind's script exited non-zero. Used to keep the Deploy
// panel (and its log) on screen when a failed create still left a droplet
// behind — otherwise isDeployed() flips the Action tab to empty Teardown
// and the operator never sees why it failed.
export function hasFailedExit(kind: RunKind, appName: string): boolean {
  const run = getGameRun(kind, appName);
  return Boolean(!run.running && run.lastExit && run.lastExit.code !== 0);
}

// True when this session still has a create log buffered for the game —
// used to keep the Deploy log on screen after a successful create, instead
// of hiding the whole panel the instant isDeployed() flips to Teardown.
export function hasCreateLog(appName: string): boolean {
  if (!appName) return false;
  const run = getGameRun("create", appName);
  return run.lines.length > 0 || Boolean(run.lastExit);
}

// Which script, if any, is currently running for this game. A run in flight
// outranks Digital Ocean's reported status when deciding which panel to
// show: mid-deploy the droplet already exists while the app doesn't, so
// status alone reads as "deployed" and would wrongly offer Teardown.
export function runningKind(appName: string): RunKind | null {
  if (!appName) return null;
  if (getGameRun("create", appName).running) return "create";
  if (getGameRun("delete", appName).running) return "delete";
  if (getGameRun("redeploy", appName).running) return "redeploy";
  return null;
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): void {
  listeners.add(listener);
}

export function notify(): void {
  for (const l of listeners) l();
}

export function preflightPassed(): boolean {
  if (!state.preflight) return false;
  if (state.preflight.wslBlocking) return false;
  return state.preflight.checks.every((c) => c.ok);
}

// True when the operator can choose between Redeploy and Teardown: the game
// has a deployed app, and nothing is in flight or left half-done. Otherwise
// only one of them makes sense and manageMode() picks it.
export function manageSwitchAvailable(): boolean {
  const appName = state.appName;
  return (
    Boolean(appName) &&
    state.status?.appExists === true &&
    runningKind(appName) === null &&
    !hasFailedExit("create", appName)
  );
}

// Which of Redeploy / Teardown the Manage tab shows right now. A run in flight
// pins its own panel (so its progress stays on screen); no deployed app, or a
// failed deploy that left resources behind, leaves only Teardown; otherwise
// it's whatever the operator picked.
export function manageMode(): "redeploy" | "teardown" {
  const kind = runningKind(state.appName);
  if (kind === "redeploy") return "redeploy";
  if (kind === "delete") return "teardown";
  if (!manageSwitchAvailable()) return "teardown";
  return state.manageMode;
}

// isDeployed is null while status hasn't been checked yet (e.g. no game
// selected), so callers can distinguish "unknown" from "known not deployed".
export function isDeployed(): boolean | null {
  if (!state.status) return null;
  return state.status.dropletExists || state.status.appExists;
}
