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

  // Games whose group the operator has expanded, kept across re-renders
  // (render() rebuilds the list from scratch each time).
  const openGames = new Set<string>();

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
    return !result.wslBlocking && result.checks.every((c) => c.ok) && gameFailures(result) === 0;
  }

  // Failing per-game checks (see PreflightResult.games). Counted in the
  // summary, but never part of state.ts's preflightPassed() — one game's
  // unreachable repo must not stop the other games from deploying.
  function gameFailures(result: NonNullable<typeof state.preflight>): number {
    return (result.games ?? []).reduce((n, g) => n + g.checks.filter((c) => !c.ok).length, 0);
  }

  function render() {
    const result = state.preflight;
    list.style.display = state.prereqExpanded ? "block" : "none";

    if (!result) {
      summary.innerHTML = `Checking prerequisites…`;
      return;
    }

    const failing = result.wslBlocking ? 1 : result.checks.filter((c) => !c.ok).length + gameFailures(result);
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
      list.appendChild(checkRow(check));
    }

    // One expandable group per game, collapsed unless something in it failed
    // (or the operator opened it), so a long list of healthy repos stays quiet.
    for (const game of result.games ?? []) {
      const bad = game.checks.filter((c) => !c.ok).length;
      const group = document.createElement("details");
      group.className = "prereq-game";
      group.open = bad > 0 || openGames.has(game.game);
      group.ontoggle = () => {
        if (group.open) openGames.add(game.game);
        else openGames.delete(game.game);
      };
      const heading = document.createElement("summary");
      const mark = document.createElement("span");
      mark.className = bad === 0 ? "ok" : "fail";
      mark.textContent = bad === 0 ? "✓" : "✗";
      const name = document.createElement("strong");
      name.textContent = game.game;
      const note = document.createElement("span");
      note.className = "prereq-game-note";
      note.textContent = bad === 0 ? "repos reachable" : `${bad} repo problem${bad > 1 ? "s" : ""} — other games are unaffected`;
      heading.append(mark, name, note);
      group.appendChild(heading);
      for (const check of game.checks) group.appendChild(checkRow(check));
      list.appendChild(group);
    }
    list.appendChild(refreshButton);
  }

  function checkRow(check: { name: string; ok: boolean; detail: string }): HTMLElement {
    const row = document.createElement("div");
    row.className = "check-row";
    const mark = document.createElement("span");
    mark.className = check.ok ? "ok" : "fail";
    mark.textContent = check.ok ? "✓" : "✗";
    const name = document.createElement("strong");
    name.textContent = check.name;
    row.append(mark, name, ` — ${check.detail}`);
    return row;
  }

  void refresh();
  render();
  return { el, render };
}
