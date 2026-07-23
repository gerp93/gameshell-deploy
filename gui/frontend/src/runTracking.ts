import { onLog, onExit, type ExitInfo, type LogLine } from "./api";
import { appendGameRunLine, getGameRun, notify } from "./state";

// Routes create:log/create:exit and delete:log/delete:exit events into
// per-game state (see state.ts's GameRun) so multiple games' runs can be in
// flight at once without stepping on each other.
//
// Log *lines* are high-frequency, so they bypass the app-wide notify() —
// logPane.ts subscribes directly via onLine() and appends to the DOM itself
// when the line belongs to the currently-displayed game, rather than
// re-rendering every panel on every line. Exits are infrequent and change
// button/tab state app-wide, so those do call notify().
//
// Listeners are split by kind ("create" vs "delete"): the Deploy panel only
// cares about create:exit, Teardown only about delete:exit — a shared
// listener set would fire a deploy's onFinished callback when an unrelated
// teardown finishes (and vice versa).

type LineListener = (line: LogLine) => void;
type ExitListener = (info: ExitInfo) => void;
type Kind = "create" | "delete";

const lineListeners: Record<Kind, Set<LineListener>> = { create: new Set(), delete: new Set() };
const exitListeners: Record<Kind, Set<ExitListener>> = { create: new Set(), delete: new Set() };

export function onLine(kind: Kind, fn: LineListener): void {
  lineListeners[kind].add(fn);
}

export function onFinish(kind: Kind, fn: ExitListener): void {
  exitListeners[kind].add(fn);
}

function wireKind(logEvent: "create:log" | "delete:log", exitEvent: "create:exit" | "delete:exit", kind: Kind) {
  onLog(logEvent, (line) => {
    getGameRun(kind, line.appName).running = true;
    appendGameRunLine(kind, line);
    for (const fn of lineListeners[kind]) fn(line);
  });

  onExit(exitEvent, (info) => {
    const run = getGameRun(kind, info.appName);
    run.running = false;
    run.lastExit = { code: info.code, err: info.err };
    for (const fn of exitListeners[kind]) fn(info);
    notify();
  });
}

// Call once at startup (see main.ts).
export function initRunTracking(): void {
  wireKind("create:log", "create:exit", "create");
  wireKind("delete:log", "delete:exit", "delete");
}
