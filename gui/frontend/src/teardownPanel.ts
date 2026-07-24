import { runDelete } from "./api";
import { createLogPane } from "./logPane";
import { refreshStatus } from "./appPanel";
import { state, preflightPassed, isDeployed, isGameRunning, getGameRun, notify } from "./state";
import { createRunSummary } from "./runSummary";

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
  gpgPassphraseInput.oninput = () => render();
  gpgPassphraseWrap.append(gpgPassphraseLabel, gpgPassphraseInput);

  // Teardown-only: a typo'd passphrase here silently GPG-encrypts the
  // backup with the wrong password before the droplet is gone, so there's
  // no way to recover the mistake afterward — a confirmation field catches
  // that before it happens. The deploy side doesn't need this: a wrong
  // passphrase there just fails to decrypt an existing backup, loudly and
  // recoverably, since nothing is destroyed.
  const gpgConfirmWrap = document.createElement("div");
  gpgConfirmWrap.className = "field";
  const gpgConfirmLabel = document.createElement("label");
  gpgConfirmLabel.textContent = "Confirm GPG_PASSPHRASE";
  const gpgConfirmInput = document.createElement("input");
  gpgConfirmInput.type = "password";
  gpgConfirmInput.oninput = () => render();
  gpgConfirmWrap.append(gpgConfirmLabel, gpgConfirmInput);
  const gpgMismatchWarning = document.createElement("div");
  gpgMismatchWarning.className = "status-line";

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
        state.status = { dropletExists: false, appExists: false, appURL: "" };
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
    // arrives) so the button/tab reflect it right away, and record what it's
    // running with (never the passphrase itself).
    const run = getGameRun("delete", appName);
    run.running = true;
    run.lastExit = undefined;
    run.params = [["Back up database first", backup === "yes" ? "yes" : "no"]];
    teardownButton.disabled = true;
    gpgPassphraseInput.value = "";
    gpgConfirmInput.value = "";
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

  const runSummary = createRunSummary("delete");

  // Hidden while a teardown is in flight — same reasoning as the deploy
  // panel: a run you switch back to should show progress, not a form.
  const formParts = [
    backupLabelYes,
    backupLabelNo,
    gpgPassphraseWrap,
    gpgConfirmWrap,
    gpgMismatchWarning,
    teardownButton,
  ];

  el.append(
    backupLabelYes,
    backupLabelNo,
    gpgPassphraseWrap,
    gpgConfirmWrap,
    gpgMismatchWarning,
    teardownButton,
    runSummary.el,
    logPane.el,
    status,
  );

  // Split from updateGPGVisibility so render() can re-apply it after
  // restoring the form (which sets every part back to display:"") without
  // recursing back into render().
  function applyGPGVisibility() {
    const show = backupYes.checked;
    gpgPassphraseWrap.style.display = show ? "" : "none";
    gpgConfirmWrap.style.display = show ? "" : "none";
  }

  function updateGPGVisibility() {
    if (!backupYes.checked) {
      gpgPassphraseInput.value = "";
      gpgConfirmInput.value = "";
    }
    applyGPGVisibility();
    render();
  }
  updateGPGVisibility();

  function gpgMismatch(): boolean {
    return backupYes.checked && gpgPassphraseInput.value !== gpgConfirmInput.value;
  }

  function render() {
    // Mirror of the deploy panel: a teardown in flight outranks status
    // (which flips to "not deployed" the moment the droplet goes, partway
    // through the run), and a deploy in flight keeps this panel hidden even
    // once its droplet starts existing.
    const running = isGameRunning("delete", state.appName);
    const deploying = isGameRunning("create", state.appName);
    const show = Boolean(state.appName) && !deploying && (running || isDeployed() === true);
    el.style.display = show ? "" : "none";
    if (!show) return;

    logPane.showGame(state.appName);
    runSummary.render(state.appName, { running: "Tearing down", done: "Torn down" });
    for (const part of formParts) part.style.display = running ? "none" : "";
    if (!running) applyGPGVisibility();

    const ready = Boolean(state.opsDir && preflightPassed());
    el.dataset.disabled = ready && !running ? "false" : "true";
    const mismatch = gpgMismatch();
    teardownButton.disabled = !ready || running || mismatch;
    gpgMismatchWarning.textContent = mismatch ? "GPG_PASSPHRASE and its confirmation don't match." : "";
    status.textContent = preflightPassed() ? "" : "Fix the failing Prerequisites checks above before tearing down.";
  }

  render();
  return { el, render };
}
