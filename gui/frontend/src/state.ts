import type { DeployConf, LogLine, PreflightResult, StatusResult } from "./api";

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
  activeTab: "action" as "config" | "action",
  prereqExpanded: false,
  // true while chooseApp() is loading a newly-selected game's deploy.conf +
  // DO status — both hit disk/doctl and can take a couple of seconds.
  loadingGame: false,
};

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

export type RunKind = "create" | "delete";

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
const gameRuns: Record<RunKind, Map<string, GameRun>> = { create: new Map(), delete: new Map() };

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

export function isGameRunning(kind: RunKind, appName: string): boolean {
  return getGameRun(kind, appName).running;
}

// Which script, if any, is currently running for this game. A run in flight
// outranks Digital Ocean's reported status when deciding which panel to
// show: mid-deploy the droplet already exists while the app doesn't, so
// status alone reads as "deployed" and would wrongly offer Teardown.
export function runningKind(appName: string): RunKind | null {
  if (!appName) return null;
  if (getGameRun("create", appName).running) return "create";
  if (getGameRun("delete", appName).running) return "delete";
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

// isDeployed is null while status hasn't been checked yet (e.g. no game
// selected), so callers can distinguish "unknown" from "known not deployed".
export function isDeployed(): boolean | null {
  if (!state.status) return null;
  return state.status.dropletExists || state.status.appExists;
}
