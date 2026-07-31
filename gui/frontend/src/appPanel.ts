import { checkStatus, getOpsDir, listGames, loadDeployConf, loadSettings, selectApp, type StatusResult } from "./api";
import { state, notify, runningKind } from "./state";

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

// Re-checks status a few seconds after a run finishes. Both panels write an
// optimistic status the moment their script exits (deploy → deployed,
// teardown → not deployed) because DO's list endpoints lag several seconds
// behind reality. That write is a prediction, though, and if anything about
// it is wrong the UI stays wrong until the operator reselects the game —
// which is how a finished teardown can sit there still offering Teardown.
// This reconciles against the real API once the lag has passed.
//
// A single disagreeing read isn't trusted on its own: DO's list endpoints
// can lag in EITHER direction — a just-deleted droplet/app can still show
// up as existing for a few seconds too, not just a just-created one being
// missing. Trusting the first disagreement outright is what made a
// successful teardown flip back to showing Teardown a few seconds later,
// even though the optimistic "not deployed" was the correct answer and DO
// just hadn't caught up to its own deletion yet. Requiring two consecutive
// disagreeing reads, spaced delayMs apart, filters that out while still
// self-healing a genuinely wrong optimistic value (which keeps disagreeing).
export function scheduleStatusReconcile(appName: string, delayMs = 6000): void {
  const deployed = (s: StatusResult) => s.dropletExists || s.appExists;

  async function probe(): Promise<StatusResult | null> {
    // Skip if the operator moved on, or a new run started — that run now
    // owns this game's status and will reconcile when it finishes.
    if (state.appName !== appName || runningKind(appName) || !state.deployConf?.appName) return null;
    try {
      return await checkStatus(state.deployConf.appName);
    } catch {
      return null; // a failed re-check shouldn't clobber the optimistic value
    }
  }

  setTimeout(() => {
    void (async () => {
      const optimistic = state.status;
      const first = await probe();
      if (!first) return;
      if (!optimistic || deployed(first) === deployed(optimistic)) {
        // Agrees (or there was nothing to compare against) — safe to apply
        // immediately, this also picks up incidental changes like a
        // just-assigned app URL.
        state.status = first;
        notify();
        return;
      }

      // Disagrees with the optimistic value — could be genuine staleness,
      // or DO's list API still catching up to the create/delete that just
      // happened. Check again before trusting it.
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const second = await probe();
      if (!second) return;
      if (deployed(second) === deployed(first)) {
        // Two consecutive reads agree with each other, and both disagree
        // with the optimistic value — it really was wrong.
        state.status = second;
        notify();
      }
      // Otherwise: the second read no longer agrees with the first either
      // (still settling) — leave the optimistic value in place rather than
      // act on an unstable reading. A later manual refresh/reselect will
      // pick up wherever it lands.
    })();
  }, delayMs);
}

// Re-lists games/ and updates state.games — exported so configForm (after
// creating a brand new game's deploy.conf) and gameHeader (after deleting
// one) can refresh the sidebar without reaching into its closure directly.
// clearSelectionIfGone drops the current selection if it's no longer on
// disk, e.g. after a manual refresh finds the folder deleted out from under
// the app, or right after this app deletes it itself.
export async function refreshGames(clearSelectionIfGone = false): Promise<void> {
  if (!state.opsDir) return;
  state.games = await listGames(state.opsDir);
  if (clearSelectionIfGone && state.appName && !state.games.includes(state.appName)) {
    state.appName = "";
    state.deployConfFound = false;
    state.deployConf = null;
    state.status = null;
  }
  notify();
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

  function renderList() {
    list.innerHTML = "";
    if (state.games.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = "No games yet — add one below.";
      list.appendChild(empty);
      return;
    }
    for (const name of state.games) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "game-item" + (name === state.appName ? " active" : "");
      item.textContent = name;
      // Mark games with a script in flight, so a deploy left running in the
      // background is visible from the sidebar rather than only after
      // selecting that game again.
      const kind = runningKind(name);
      if (kind) {
        const dot = document.createElement("span");
        dot.className = "game-item-running";
        dot.textContent = "●";
        dot.title = kind === "create" ? "Deploying…" : "Tearing down…";
        item.appendChild(dot);
      }
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
      if (!state.games.includes(appName)) {
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
