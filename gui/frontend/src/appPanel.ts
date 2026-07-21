import { checkStatus, getOpsDir, listGames, loadDeployConf, loadSettings, selectApp } from "./api";
import { state, notify } from "./state";

// Re-checks Digital Ocean status for the currently selected game — exported
// so deployPanel/teardownPanel can call it once a run finishes, since a
// deploy/teardown changes whether the other panel should be enabled.
export async function refreshStatus(): Promise<void> {
  if (!state.deployConfFound || !state.deployConf?.appName) {
    state.status = null;
    return;
  }
  state.status = await checkStatus(state.deployConf.appName);
}

// The sidebar: a list of games under games/, plus a small "add new" form at
// the bottom. Selecting a game loads its deploy.conf and DO status; the
// main content area (see main.ts) reacts to state.appName changing.
export function createAppPanel(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("aside");
  el.className = "sidebar";

  const headingRow = document.createElement("div");
  headingRow.className = "sidebar-heading-row";
  const heading = document.createElement("div");
  heading.className = "sidebar-heading";
  heading.textContent = "Games";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "icon-button";
  refreshButton.title = "Refresh game list";
  refreshButton.textContent = "⟳";
  refreshButton.onclick = () => void refreshGames(true);
  headingRow.append(heading, refreshButton);

  const list = document.createElement("div");
  list.className = "game-list";

  const newWrap = document.createElement("div");
  newWrap.className = "sidebar-new";
  const newNameInput = document.createElement("input");
  newNameInput.placeholder = "new-app-name";
  const useNewButton = document.createElement("button");
  useNewButton.type = "button";
  useNewButton.className = "secondary";
  useNewButton.textContent = "+ Add game";
  useNewButton.onclick = () => {
    const name = newNameInput.value.trim();
    if (name) {
      newNameInput.value = "";
      void chooseApp(name);
    }
  };
  newWrap.append(newNameInput, useNewButton);

  const errorBox = document.createElement("div");
  errorBox.className = "sidebar-error";

  el.append(headingRow, list, newWrap, errorBox);

  let games: string[] = [];

  // clearSelectionIfGone: after a manual refresh, the currently selected
  // game's folder may have been deleted from disk — drop the selection
  // rather than keep showing stale deploy.conf/status for a game that's
  // gone.
  async function refreshGames(clearSelectionIfGone = false) {
    if (!state.opsDir) return;
    games = await listGames(state.opsDir);
    if (clearSelectionIfGone && state.appName && !games.includes(state.appName)) {
      state.appName = "";
      state.deployConfFound = false;
      state.deployConf = null;
      state.status = null;
      notify();
    }
    renderList();
  }

  function renderList() {
    list.innerHTML = "";
    if (games.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = "No games yet — add one below.";
      list.appendChild(empty);
      return;
    }
    for (const name of games) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "game-item" + (name === state.appName ? " active" : "");
      item.textContent = name;
      item.onclick = () => void chooseApp(name);
      list.appendChild(item);
    }
  }

  async function chooseApp(appName: string) {
    state.appName = appName;
    state.loadingGame = true;
    notify();
    try {
      await selectApp(appName);
      const result = await loadDeployConf(state.opsDir, appName);
      state.deployConfFound = result.found;
      state.deployConf = result.found ? result.conf : null;
      await refreshStatus();
      if (!games.includes(appName)) {
        await refreshGames();
      } else {
        renderList();
      }
    } finally {
      state.loadingGame = false;
      notify();
    }
  }

  void (async () => {
    try {
      state.opsDir = await getOpsDir();
    } catch (err) {
      errorBox.textContent = String(err);
      newWrap.style.display = "none";
      notify();
      return;
    }
    await refreshGames();
    const s = await loadSettings();
    if (s.lastAppName) {
      await chooseApp(s.lastAppName);
    }
    notify();
  })();

  return {
    el,
    render: () => {
      renderList();
    },
  };
}
