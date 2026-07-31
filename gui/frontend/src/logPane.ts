import type { ExitInfo, LogLine } from "./api";
import { getGameRun, type RunKind } from "./state";
import { onLine, onFinish } from "./runTracking";

export interface LogPane {
  el: HTMLDivElement;
  // Call whenever the selected game changes — redraws from that game's own
  // buffered history (see state.ts's GameRun) instead of clearing it, so
  // switching back to a game mid-run (or after it's finished) still shows
  // its output.
  showGame(appName: string): void;
}

function exitText(info: { code: number; err?: string }): string {
  return info.err ? `-- exited with code ${info.code}: ${info.err} --` : `-- exited with code ${info.code} --`;
}

// kind selects which event stream this pane cares about ("create" for the
// Deploy tab, "delete" for Teardown) — each game's create/delete history is
// tracked separately (see state.ts), so a game's Deploy log never shows its
// past Teardown output or vice versa.
export function createLogPane(kind: RunKind, onFinished: (info: ExitInfo) => void): LogPane {
  const el = document.createElement("div");
  el.className = "log-pane";

  let currentApp = "";

  function appendRow(text: string, stderr: boolean) {
    const row = document.createElement("div");
    if (stderr) row.className = "stderr";
    row.textContent = text;
    el.appendChild(row);
  }

  function redraw() {
    el.innerHTML = "";
    const run = getGameRun(kind, currentApp);
    for (const line of run.lines) {
      appendRow(line.text, line.stream === "stderr");
    }
    if (run.lastExit) {
      appendRow(exitText(run.lastExit), false);
    }
    el.scrollTop = el.scrollHeight;
  }

  onLine(kind, (line: LogLine) => {
    if (line.appName !== currentApp) return;
    appendRow(line.text, line.stream === "stderr");
    el.scrollTop = el.scrollHeight;
  });

  onFinish(kind, (info: ExitInfo) => {
    if (info.appName === currentApp) {
      appendRow(exitText(info), false);
      el.scrollTop = el.scrollHeight;
    }
    onFinished(info);
  });

  return {
    el,
    showGame(appName: string) {
      if (appName === currentApp) return;
      currentApp = appName;
      redraw();
    },
  };
}
