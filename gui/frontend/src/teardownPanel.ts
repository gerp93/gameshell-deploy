import { runDelete, listSSHKeys, loadSecrets, loadSettings, saveSecrets } from "./api";
import { createLogPane } from "./logPane";
import { refreshStatus, scheduleStatusReconcile } from "./appPanel";
import { state, preflightPassed, isDeployed, isGameRunning, hasFailedExit, getGameRun, clearGameRun, notify } from "./state";
import { createRunSummary } from "./runSummary";

export function createTeardownPanel(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.innerHTML = `<p class="hint">Deletes the droplet and app for this game.</p>`;

  const leftoverHint = document.createElement("p");
  leftoverHint.className = "hint";

  // Same DigitalOcean key list as the deploy panel. Backup ssh/scp has to
  // offer the private key that matches whatever was attached at create
  // time — with two similar names, ssh-agent can try the wrong one first
  // (or exhaust MaxAuthTries) unless delete.sh is told which key to pin.
  const sshKeyWrap = document.createElement("div");
  sshKeyWrap.className = "field";
  const sshKeyLabel = document.createElement("label");
  sshKeyLabel.textContent = "SSH key (must match the one attached at create)";
  const sshKeyRow = document.createElement("div");
  sshKeyRow.className = "row";
  const sshKeySelect = document.createElement("select");
  const refreshKeysButton = document.createElement("button");
  refreshKeysButton.type = "button";
  refreshKeysButton.className = "secondary";
  refreshKeysButton.textContent = "Refresh";
  refreshKeysButton.onclick = () => void refreshKeys();
  sshKeySelect.onchange = () => render();
  sshKeyRow.append(sshKeySelect, refreshKeysButton);
  sshKeyWrap.append(sshKeyLabel, sshKeyRow);

  async function refreshKeys() {
    sshKeySelect.innerHTML = "";
    try {
      const keys = (await listSSHKeys()) ?? [];
      for (const key of keys) {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = key;
        sshKeySelect.appendChild(opt);
      }
    } catch {
      // doctl unavailable — Teardown stays disabled while backup is on.
    }
    render();
  }

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

  let gpgKeyringTried = false;
  async function fillGPGFromKeyring() {
    if (gpgKeyringTried || gpgPassphraseInput.value) return;
    gpgKeyringTried = true;
    try {
      const bundle = await loadSecrets([]);
      if (bundle.gpgPassphrase && !gpgPassphraseInput.value) {
        gpgPassphraseInput.value = bundle.gpgPassphrase;
        gpgConfirmInput.value = bundle.gpgPassphrase;
        render();
      }
    } catch {
      // Keyring unavailable — type the passphrase this run.
    }
  }

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
        // Whatever deploy history existed for this game was for the
        // deployment that just got torn down — a successful teardown makes
        // it stale, and leaving it in place is what made switching to
        // Deploy right after tearing down show an unrelated old run.
        clearGameRun("create", info.appName);
      } else {
        await refreshStatus();
      }
      render();
      notify();
      scheduleStatusReconcile(info.appName);
    })();
  });

  teardownButton.onclick = async () => {
    if (!state.appName || !state.opsDir) return;
    const appName = state.appName;
    const backup = backupYes.checked ? "yes" : "no";
    const sshKeyName = sshKeySelect.value;
    const gpgPassphrase = gpgPassphraseInput.value;

    // Mark this game as running immediately (before the first log line
    // arrives) so the button/tab reflect it right away, and record what it's
    // running with (never the passphrase itself).
    clearGameRun("delete", appName);
    const run = getGameRun("delete", appName);
    run.running = true;
    run.params = [
      ["Back up database first", backup === "yes" ? "yes" : "no"],
      ...(backup === "yes" ? [["SSH key", sshKeyName] as [string, string]] : []),
    ];
    teardownButton.disabled = true;
    const s = await loadSettings();
    if (s.rememberSecrets && gpgPassphrase) {
      try {
        await saveSecrets({
          sqlUser: "",
          sqlPassword: "",
          gpgPassphrase,
          extraEnv: [],
        });
      } catch {
        // Don't block teardown if the keychain write fails.
      }
    }
    if (!s.rememberSecrets) {
      gpgPassphraseInput.value = "";
      gpgConfirmInput.value = "";
    }
    notify();

    await runDelete({
      opsDir: state.opsDir,
      appName,
      backup,
      sshKeyName: backup === "yes" ? sshKeyName : "",
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
    sshKeyWrap,
    backupLabelYes,
    backupLabelNo,
    gpgPassphraseWrap,
    gpgConfirmWrap,
    gpgMismatchWarning,
    teardownButton,
  ];

  el.append(
    leftoverHint,
    sshKeyWrap,
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
    sshKeyWrap.style.display = show ? "" : "none";
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
    leftoverHint.textContent =
      hasFailedExit("create", state.appName) && isDeployed() === true
        ? "Deploy failed after creating cloud resources. The deploy log is above — teardown when you're ready to clean up. If SSH backup fails with Permission denied, skip the backup: a mangled SSH key at create time can leave the droplet with no usable key."
        : "";
    leftoverHint.style.display = leftoverHint.textContent ? "" : "none";
    runSummary.render(state.appName, { running: "Tearing down", done: "Torn down" });
    for (const part of formParts) part.style.display = running ? "none" : "";
    if (!running) {
      applyGPGVisibility();
      void fillGPGFromKeyring();
    }

    const ready = Boolean(state.opsDir && preflightPassed());
    // See deployPanel.ts's identical comment: don't dim the log/summary the
    // operator is watching just because the (hidden) form beneath it isn't
    // ready — only applies while the form itself is actually shown.
    el.dataset.disabled = !running && !ready ? "true" : "false";
    const mismatch = gpgMismatch();
    const missingKey = backupYes.checked && !sshKeySelect.value;
    teardownButton.disabled = !ready || running || mismatch || missingKey;
    gpgMismatchWarning.textContent = mismatch ? "GPG_PASSPHRASE and its confirmation don't match." : "";
    status.textContent = preflightPassed() ? "" : "Fix the failing Prerequisites checks above before tearing down.";
  }

  void refreshKeys();
  render();
  return { el, render };
}
