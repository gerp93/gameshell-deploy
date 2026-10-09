import type { DeployConf, StatusResult } from "./api";
import { state, runningKind } from "./state";

// How long a game has been costing money, and the sidebar tag that shows it.
// The clock comes from Digital Ocean (StatusResult.upSince: the earlier of the
// droplet's and the app's creation time), not from anything this app
// remembers, so it is right even for a game deployed from the CLI or from
// another computer, and a redeploy doesn't reset it.

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Milliseconds since the game came up, or null when nothing is up (or DO gave
// no usable time).
export function uptimeMs(status: StatusResult | null, now = Date.now()): number | null {
  if (!status || !status.upSince || !(status.dropletExists || status.appExists)) return null;
  const since = Date.parse(status.upSince);
  return Number.isNaN(since) ? null : Math.max(0, now - since);
}

// deploy.conf's MAX_UPTIME_HOURS as hours; 0 means no limit. Mirrors
// DeployConf.MaxUptime() in Go: blank or anything but a positive whole number
// is "no limit".
export function maxUptimeHours(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const n = parseInt(text, 10);
  return n >= 1 ? n : 0;
}

export function isOverLimit(uptime: number | null, limitHours: number): boolean {
  return uptime !== null && limitHours > 0 && uptime > limitHours * 3600 * 1000;
}

// What a script in flight is doing, for the header pill and the sidebar tag.
// While one runs, Digital Ocean's deployed/not-deployed answer is a snapshot of
// a half-finished job, so this takes its place rather than contradicting it.
export function busyLabel(kind: "create" | "delete" | "redeploy"): string {
  return kind === "create" ? "Deploying…" : kind === "redeploy" ? "Redeploying…" : "Tearing down…";
}

export interface GameTag {
  kind: "busy" | "up" | "over" | "partial" | "down" | "none";
  label: string;
  title: string;
}

// The sidebar tag for one game. status null means "not known yet", which
// shows nothing rather than guessing "down".
export function gameTag(hasConf: boolean, status: StatusResult | null, limitHours: number, now = Date.now()): GameTag {
  if (!hasConf) return { kind: "none", label: "not configured", title: "No deploy.conf yet — set it up in the Config tab." };
  if (!status) return { kind: "none", label: "", title: "" };

  const uptime = uptimeMs(status, now);
  const age = uptime === null ? "" : ` · ${formatDuration(uptime)}`;

  if (status.dropletExists && status.appExists) {
    if (isOverLimit(uptime, limitHours)) {
      return {
        kind: "over",
        label: `deployed${age} · over ${limitHours}h`,
        title: `Up past its ${limitHours}h limit (MAX_UPTIME_HOURS) — it's still being billed.`,
      };
    }
    return { kind: "up", label: `deployed${age}`, title: "The app and its database droplet are both up." };
  }
  if (status.dropletExists || status.appExists) {
    const only = status.dropletExists ? "database droplet" : "app";
    return {
      kind: "partial",
      label: `partial${age}`,
      title: `Only the ${only} exists — a deploy or teardown didn't finish. It's still being billed.`,
    };
  }
  return { kind: "down", label: "down", title: "Nothing is deployed." };
}

// The tag for a game by its games/ directory name. The selected game uses the
// live status the rest of the UI works from (which a deploy or teardown
// updates the moment it finishes); the others use the latest account-wide
// listing.
export function tagForGame(game: string, now = Date.now()): GameTag {
  const running = runningKind(game);
  if (running) {
    const label = busyLabel(running).toLowerCase();
    return { kind: "busy", label, title: "A script is running for this game right now." };
  }
  // state.status still belongs to the previous game until loading finishes.
  if (game === state.appName && !state.loadingGame && state.deployConfFound && state.deployConf) {
    const conf: DeployConf = state.deployConf;
    return gameTag(true, state.status, maxUptimeHours(conf.maxUptimeHours), now);
  }
  const entry = state.gameStatuses.find((g) => g.game === game);
  if (!entry) return { kind: "none", label: "", title: "" };
  return gameTag(entry.hasConf, entry.hasConf ? entry.status : null, entry.maxUptimeHours, now);
}
