import type { DeployConf, PreflightResult } from "./api";

// Plain module-level state — no state-management library, this app only
// has a handful of panels.
export const state = {
  opsDir: "",
  gameRepoDir: "",
  deployConfFound: false,
  deployConf: null as DeployConf | null,
  preflight: null as PreflightResult | null,
  running: false,
};

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
