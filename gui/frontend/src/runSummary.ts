import { getGameRun, type RunKind } from "./state";

// The banner shown above a run's log: what the run is doing (or how it
// ended) plus the settings it was launched with. Both panels use it, since
// switching away mid-run and back is exactly when "what is this doing, and
// with what?" needs answering — the form itself is hidden at that point.
export interface RunSummary {
  el: HTMLElement;
  render: (appName: string, verb: { running: string; done: string }) => void;
}

export function createRunSummary(kind: RunKind): RunSummary {
  const el = document.createElement("div");
  el.className = "run-summary";

  const heading = document.createElement("div");
  heading.className = "run-summary-heading";

  const params = document.createElement("dl");
  params.className = "run-summary-params";

  el.append(heading, params);

  return {
    el,
    render(appName, verb) {
      const run = getGameRun(kind, appName);
      // Nothing to summarise until a run has actually been launched from
      // this app — a game with no history shows just its form.
      const hasRun = run.running || Boolean(run.lastExit);
      el.style.display = hasRun ? "" : "none";
      if (!hasRun) return;

      if (run.running) {
        heading.textContent = `${verb.running}…`;
        heading.className = "run-summary-heading running";
      } else if (run.lastExit?.code === 0) {
        heading.textContent = `${verb.done} successfully.`;
        heading.className = "run-summary-heading ok";
      } else {
        heading.textContent = `Last run failed (exit code ${run.lastExit?.code}).`;
        heading.className = "run-summary-heading failed";
      }

      params.innerHTML = "";
      for (const [label, value] of run.params ?? []) {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        params.append(dt, dd);
      }
    },
  };
}
