import { runDelete } from "./api";
import { createLogPane } from "./logPane";
import { refreshStatus } from "./appPanel";
import { state, preflightPassed, isDeployed, isGameRunning, getGameRun, notify } from "./state";

export function createTeardownPanel(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.innerHTML = `<p class="hint">Deletes the droplet and app for this game.</p>`;

  const status = document.createElement("div");
  status.className = "status-line";

  const backupYes = document.createElement("input");
  backupYes.type = "radio";
  backupYes.name = "backup";
  backupYes.value = "yes";
  backupYes.checked = true;
  backupYes.onchange = () => updateGPGVisibility();
  const backupNo = document.createElement("input");
  backupNo.type = "radio";
  backupNo.name = "backup";
  backupNo.value = "no";
  backupNo.onchange = () => updateGPGVisibility();

  const gpgPassphraseWrap = document.createElement("div");
  gpgPassphraseWrap.className = "field";
  const gpgPassphraseLabel = document.createElement("label");
  gpgPassphraseLabel.textContent = "GPG_PASSPHRASE (only if backing up)";
  const gpgPassphraseInput = document.createElement("input");
  gpgPassphraseInput.type = "password";
  gpgPassphraseWrap.append(gpgPassphraseLabel, gpgPassphraseInput);

  const teardownButton = document.createElement("button");
  teardownButton.textContent = "Teardown";
  teardownButton.style.marginTop = "0.5rem";

  // delete.sh can run for several games at once (see scriptrunner.go) — this
  // pane just re-points at whichever game is currently selected.
  const logPane = createLogPane("delete", (info) => {
    // Only touch global status if this finish is for the game currently on
    // screen — a background game's status gets rechecked fresh whenever the
    // operator selects it (see appPanel.ts's chooseApp).
    if (info.appName !== state.appName) return;
    void (async () => {
      // On success we already know the outcome — delete.sh just finished
      // deleting the droplet + app — so set status directly rather than
      // re-querying doctl immediately after, which can still report the old
      // state for a few seconds (DO API eventual consistency). Only a
      // failure (partial/unknown state) needs a real re-check.
      if (info.code === 0) {
        state.status = { dropletExists: false, appExists: false };
      } else {
        await refreshStatus();
      }
      render();
      notify();
    })();
  });

  teardownButton.onclick = async () => {
    if (!state.appName || !state.opsDir) return;
    const appName = state.appName;
    const backup = backupYes.checked ? "yes" : "no";
    const gpgPassphrase = gpgPassphraseInput.value;

    // Mark this game as running immediately (before the first log line
    // arrives) so the button/tab reflect it right away.
    getGameRun("delete", appName).running = true;
    teardownButton.disabled = true;
    gpgPassphraseInput.value = "";
    notify();

    await runDelete({
      opsDir: state.opsDir,
      appName,
      backup,
      gpgPassphrase,
    });
  };

  const backupLabelYes = document.createElement("label");
  backupLabelYes.style.display = "block";
  backupLabelYes.style.fontWeight = "normal";
  backupLabelYes.append(backupYes, " Back up database first");
  const backupLabelNo = document.createElement("label");
  backupLabelNo.style.display = "block";
  backupLabelNo.style.fontWeight = "normal";
  backupLabelNo.append(backupNo, " Skip backup");

  el.append(backupLabelYes, backupLabelNo, gpgPassphraseWrap, teardownButton, logPane.el, status);

  function updateGPGVisibility() {
    gpgPassphraseWrap.style.display = backupYes.checked ? "" : "none";
    if (!backupYes.checked) gpgPassphraseInput.value = "";
  }
  updateGPGVisibility();

  function render() {
    const deployed = isDeployed();
    const show = Boolean(state.appName) && deployed === true;
    el.style.display = show ? "" : "none";
    if (!show) return;

    logPane.showGame(state.appName);
    const running = isGameRunning("delete", state.appName);
    const ready = Boolean(state.opsDir && preflightPassed());
    el.dataset.disabled = ready && !running ? "false" : "true";
    teardownButton.disabled = !ready || running;
    status.textContent = preflightPassed() ? "" : "Fix the failing Prerequisites checks above before tearing down.";
  }

  render();
  return { el, render };
}
