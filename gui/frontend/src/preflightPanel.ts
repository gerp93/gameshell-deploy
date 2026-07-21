import { runPreflightChecks } from "./api";
import { state, notify } from "./state";

// A collapsible status bar rather than an always-expanded checklist — most
// of the time every check passes and the detail is just noise; it expands
// automatically the first time something fails, and stays collapsed
// otherwise until clicked.
export function createPreflightPanel(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.className = "prereq-bar";

  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "prereq-summary";
  summary.onclick = () => {
    state.prereqExpanded = !state.prereqExpanded;
    render();
  };

  const list = document.createElement("div");
  list.className = "prereq-list";

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "secondary";
  refreshButton.textContent = "Re-check";
  refreshButton.onclick = (e) => {
    e.stopPropagation();
    void refresh();
  };

  el.append(summary, list);

  async function refresh() {
    const result = await runPreflightChecks();
    const hadFailure = state.preflight !== null && !allPassing(state.preflight);
    state.preflight = result;
    if (!hadFailure && !allPassing(result)) {
      state.prereqExpanded = true;
    }
    render();
    notify();
  }

  function allPassing(result: NonNullable<typeof state.preflight>): boolean {
    return !result.wslBlocking && result.checks.every((c) => c.ok);
  }

  function render() {
    const result = state.preflight;
    list.style.display = state.prereqExpanded ? "block" : "none";

    if (!result) {
      summary.innerHTML = `Checking prerequisites…`;
      return;
    }

    const failing = result.wslBlocking ? 1 : result.checks.filter((c) => !c.ok).length;
    const dotClass = failing === 0 ? "ok" : "fail";
    const label = failing === 0 ? "Prerequisites OK" : `Prerequisites — ${failing} issue${failing > 1 ? "s" : ""}`;
    const chevron = state.prereqExpanded ? "▾" : "▸";
    summary.innerHTML = `<span class="dot ${dotClass}"></span> ${label} <span class="chevron">${chevron}</span>`;

    list.innerHTML = "";
    if (result.wslBlocking) {
      const row = document.createElement("div");
      row.className = "check-row";
      row.innerHTML = `<span class="fail">✗</span> <strong>WSL is required on Windows and was not found.</strong>`;
      list.appendChild(row);
      const detail = document.createElement("div");
      detail.textContent = result.checks[0]?.detail ?? "";
      list.appendChild(detail);
      list.appendChild(refreshButton);
      return;
    }

    for (const check of result.checks) {
      const row = document.createElement("div");
      row.className = "check-row";
      row.innerHTML = `<span class="${check.ok ? "ok" : "fail"}">${check.ok ? "✓" : "✗"}</span> <strong>${check.name}</strong> — ${check.detail}`;
      list.appendChild(row);
    }
    list.appendChild(refreshButton);
  }

  void refresh();
  render();
  return { el, render };
}
