import { deleteGame, openURL, renameGame, selectApp } from "./api";
import { refreshGames } from "./appPanel";
import { state, notify } from "./state";

// The selected game's name + deployed/not-deployed pill, shown above the
// Config/Deploy tabs. Also owns the "Delete game" action — it's the one
// place that always shows which game is selected and its deployed state,
// so it's where the delete confirmation lives too.
export function createGameHeader(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.className = "game-header";

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Select a game from the sidebar, or add a new one.";

  const titleRow = document.createElement("div");
  titleRow.className = "game-header-title";
  const title = document.createElement("h2");
  const pill = document.createElement("span");

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "secondary";
  deleteButton.textContent = "Delete game";
  deleteButton.onclick = () => showConfirm();

  // Shown only once a deploy has an ingress URL assigned. Opened via the Go
  // side rather than an <a href> — this is a webview, so a plain link would
  // navigate the app's own window instead of the operator's browser.
  const openAppButton = document.createElement("button");
  openAppButton.type = "button";
  openAppButton.className = "secondary";
  openAppButton.textContent = "Open app ↗";
  openAppButton.onclick = () => {
    const url = state.status?.appURL;
    if (url) void openURL(url);
  };

  // Rename edits the games/ folder name only — deploy.conf's APP_NAME, which
  // names the actual DO droplet/app, stays put and is edited in the Config
  // tab. Clicking the title itself starts the edit, with the button as the
  // discoverable affordance for that.
  const renameButton = document.createElement("button");
  renameButton.type = "button";
  renameButton.className = "secondary";
  renameButton.textContent = "Rename";
  renameButton.onclick = () => startRename();

  title.style.cursor = "pointer";
  title.title = "Click to rename";
  title.onclick = () => startRename();

  const renameInput = document.createElement("input");
  renameInput.style.display = "none";
  renameInput.style.maxWidth = "18rem";
  renameInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename();
    } else if (e.key === "Escape") {
      cancelRename();
    }
  };

  const renameSave = document.createElement("button");
  renameSave.type = "button";
  renameSave.textContent = "Save";
  renameSave.onclick = () => void commitRename();
  const renameCancel = document.createElement("button");
  renameCancel.type = "button";
  renameCancel.className = "secondary";
  renameCancel.textContent = "Cancel";
  renameCancel.onclick = () => cancelRename();

  const actions = document.createElement("div");
  actions.className = "game-header-actions";
  actions.append(openAppButton, renameButton, deleteButton);

  const renameActions = document.createElement("div");
  renameActions.className = "game-header-actions";
  renameActions.style.display = "none";
  renameActions.append(renameSave, renameCancel);

  const renameError = document.createElement("div");
  renameError.className = "status-line";

  titleRow.append(title, renameInput, pill, actions, renameActions);

  let renaming = false;

  function startRename() {
    renaming = true;
    renameInput.value = state.appName;
    renameError.textContent = "";
    applyRenameVisibility();
    renameInput.focus();
    renameInput.select();
  }

  function cancelRename() {
    renaming = false;
    renameError.textContent = "";
    applyRenameVisibility();
  }

  function applyRenameVisibility() {
    title.style.display = renaming ? "none" : "";
    renameInput.style.display = renaming ? "" : "none";
    actions.style.display = renaming ? "none" : "";
    renameActions.style.display = renaming ? "" : "none";
  }

  async function commitRename() {
    const newName = renameInput.value.trim();
    if (!newName || newName === state.appName) {
      cancelRename();
      return;
    }
    renameSave.disabled = true;
    renameError.textContent = "";
    try {
      await renameGame(state.opsDir, state.appName, newName);
      state.appName = newName;
      // Persist it as the last-used game so a restart doesn't reopen the
      // name that no longer exists.
      await selectApp(newName);
      renaming = false;
      await refreshGames();
    } catch (err) {
      renameError.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      renameSave.disabled = false;
      applyRenameVisibility();
      notify();
    }
  }

  // The URL itself, on its own line so it's readable and copyable rather
  // than only reachable through the button.
  const appURLLine = document.createElement("div");
  appURLLine.className = "game-header-url";

  // Confirmation is inline rather than a native confirm() popup, so the
  // warning text (backups included, unrecoverable) is always visible
  // rather than easy to click through without reading.
  const confirmBox = document.createElement("div");
  confirmBox.className = "status-line";
  confirmBox.style.display = "none";
  const confirmText = document.createElement("p");
  const confirmActions = document.createElement("div");
  confirmActions.className = "row";
  const confirmDeleteButton = document.createElement("button");
  confirmDeleteButton.type = "button";
  confirmDeleteButton.textContent = "Delete permanently";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "secondary";
  cancelButton.textContent = "Cancel";
  cancelButton.onclick = () => hideConfirm();
  confirmActions.append(confirmDeleteButton, cancelButton);
  const errorText = document.createElement("div");
  errorText.className = "status-line";
  confirmBox.append(confirmText, confirmActions, errorText);

  // Tracks which game the open confirmation is for, so a render triggered
  // by something unrelated (e.g. a background deploy's log line) doesn't
  // silently dismiss an open confirmation — only switching games does.
  let confirmForApp: string | null = null;

  function showConfirm() {
    confirmForApp = state.appName;
    confirmText.textContent =
      `Permanently delete games/${state.appName}/? This removes deploy.conf and any database ` +
      `backups stored locally for this game. This cannot be undone.`;
    errorText.textContent = "";
    confirmBox.style.display = "";
  }

  function hideConfirm() {
    confirmForApp = null;
    confirmBox.style.display = "none";
    errorText.textContent = "";
  }

  confirmDeleteButton.onclick = async () => {
    const appName = state.appName;
    confirmDeleteButton.disabled = true;
    errorText.textContent = "";
    try {
      await deleteGame(state.opsDir, appName);
      hideConfirm();
      await refreshGames(true);
    } catch (err) {
      errorText.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      confirmDeleteButton.disabled = false;
      notify();
    }
  };

  el.append(hint, titleRow, renameError, appURLLine, confirmBox);

  function render() {
    if (confirmForApp !== null && confirmForApp !== state.appName) hideConfirm();
    const show = Boolean(state.appName);
    hint.style.display = show ? "none" : "";
    titleRow.style.display = show ? "" : "none";
    if (!show) {
      if (renaming) cancelRename();
      return;
    }
    applyRenameVisibility();

    title.textContent = state.appName;
    const deployed = state.status ? state.status.dropletExists || state.status.appExists : null;
    pill.className = deployed === null ? "" : deployed ? "pill pill-deployed" : "pill pill-not-deployed";
    pill.textContent = deployed === null ? "" : deployed ? "Deployed" : "Not deployed";

    const appURL = state.status?.appURL ?? "";
    openAppButton.style.display = appURL ? "" : "none";
    appURLLine.textContent = appURL;
  }

  render();
  return { el, render };
}
