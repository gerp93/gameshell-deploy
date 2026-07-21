import { onLog, onExit, type ExitInfo } from "./api";

export interface LogPane {
  el: HTMLDivElement;
  clear(): void;
}

export function createLogPane(
  logEvent: "create:log" | "delete:log",
  exitEvent: "create:exit" | "delete:exit",
  onFinished: (info: ExitInfo) => void,
): LogPane {
  const el = document.createElement("div");
  el.className = "log-pane";

  onLog(logEvent, (line) => {
    const row = document.createElement("div");
    if (line.stream === "stderr") row.className = "stderr";
    row.textContent = line.text;
    el.appendChild(row);
    el.scrollTop = el.scrollHeight;
  });

  onExit(exitEvent, (info) => {
    const row = document.createElement("div");
    row.textContent = info.err ? `-- exited with code ${info.code}: ${info.err} --` : `-- exited with code ${info.code} --`;
    el.appendChild(row);
    el.scrollTop = el.scrollHeight;
    onFinished(info);
  });

  return {
    el,
    clear() {
      el.innerHTML = "";
    },
  };
}
