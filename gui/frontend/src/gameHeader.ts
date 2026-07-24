import { deleteGame, openURL } from "./api";
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
  titleRow.className = "row";
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

  titleRow.append(title, pill, openAppButton, deleteButton);

  // The URL itself, shown as text so it's readable/copyable rather than
  // hidden behind the button alone.
  const appURLLine = document.createElement("div");
  appURLLine.className = "hint";

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

  el.append(hint, titleRow, appURLLine, confirmBox);

  function render() {
    if (confirmForApp !== null && confirmForApp !== state.appName) hideConfirm();
    const show = Boolean(state.appName);
    hint.style.display = show ? "none" : "";
    titleRow.style.display = show ? "" : "none";
    if (!show) return;

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
