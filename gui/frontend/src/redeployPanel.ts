import { runRedeploy, listSSHKeys, loadSecrets, loadSettings, openBackupsFolder, saveSecrets } from "./api";
import { createLogPane } from "./logPane";
import { refreshStatus } from "./appPanel";
import { commitsText, shortSha } from "./codeBanner";
import { currentCodeCheck, refreshCodeCheck } from "./codeCheck";
import { state, preflightPassed, isGameRunning, getGameRun, clearGameRun, manageMode, notify } from "./state";
import { createRunSummary } from "./runSummary";
import { createSecretField } from "./secretField";
import { createRememberCheckbox } from "./rememberCheckbox";

// Ships the latest commit of the branch to the running app, leaving the
// database droplet alone (see redeploy.sh). Offered whenever the game has a
// deployed app — new code isn't required, the check below only reports whether
// there is any — and it sits above Teardown on the same tab.
export function createRedeployPanel(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.className = "redeploy-panel";

  const intro = document.createElement("p");
  intro.className = "hint";
  intro.textContent =
    "Builds the latest commit of the branch and rolls it out to the running app. The database droplet isn't touched; " +
    "the game migrates its own schema on startup, and if the new build fails to start the previous one keeps serving. " +
    "Env vars, app size and branch stay as they were deployed.";

  // --- is there new code? ---------------------------------------------------

  const codeLine = document.createElement("div");
  codeLine.className = "status-line";
  const checkButton = document.createElement("button");
  checkButton.type = "button";
  checkButton.className = "secondary";
  checkButton.textContent = "Check for new code";
  checkButton.onclick = () => void refreshCodeCheck();
  const codeRow = document.createElement("div");
  codeRow.className = "row";
  codeRow.append(codeLine, checkButton);

  // Destructive SQL the new commits add (see redeploy.sh's scan). The GUI can't
  // answer the script's prompt — it always runs with --yes — so this is where
  // the operator sees it and confirms before the request is even sent.
  const sqlBox = document.createElement("div");
  sqlBox.className = "sql-warning";
  const sqlHeading = document.createElement("div");
  sqlHeading.className = "sql-warning-heading";
  const sqlList = document.createElement("ul");
  const sqlNote = document.createElement("p");
  sqlNote.className = "hint";
  const ackLabel = document.createElement("label");
  ackLabel.style.display = "block";
  ackLabel.style.fontWeight = "normal";
  const ackCheck = document.createElement("input");
  ackCheck.type = "checkbox";
  ackCheck.onchange = () => render();
  ackLabel.append(ackCheck, " I've reviewed these SQL changes");
  sqlBox.append(sqlHeading, sqlList, sqlNote, ackLabel);
  // Which commit the ticked box was for — a newer one needs a fresh look.
  let ackFor = "";

  // --- backup -----------------------------------------------------------------
  //
  // Same fields as the teardown panel's backup, for the same reasons: ssh/scp
  // has to be pinned to the key attached at create time, and a typo'd GPG
  // passphrase silently encrypts the backup with the wrong password.

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
  const sshKeyHint = document.createElement("div");
  sshKeyHint.className = "hint";
  sshKeyWrap.append(sshKeyLabel, sshKeyRow, sshKeyHint);
  let keysLoadedForOpsDir = "";

  async function refreshKeys() {
    if (!state.opsDir) return;
    const previously = sshKeySelect.value;
    sshKeySelect.innerHTML = "";
    try {
      const keys = (await listSSHKeys(state.opsDir)) ?? [];
      for (const key of keys) {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = key;
        sshKeySelect.appendChild(opt);
      }
      if (previously && keys.includes(previously)) {
        sshKeySelect.value = previously;
      }
      sshKeyHint.textContent =
        keys.length > 0
          ? "Only keys that exist both on this DigitalOcean account and on this computer (~/.ssh or ssh-agent)."
          : "None of this account's SSH keys are on this computer. Add this PC's public key to DigitalOcean, or copy the matching private key into ~/.ssh. Skip backup to redeploy without SSH.";
    } catch {
      sshKeyHint.textContent = "Could not list SSH keys.";
    }
    render();
  }

  const backupYes = document.createElement("input");
  backupYes.type = "radio";
  backupYes.name = "redeploy-backup";
  backupYes.value = "yes";
  backupYes.checked = true;
  backupYes.onchange = () => updateGPGVisibility();
  const backupNo = document.createElement("input");
  backupNo.type = "radio";
  backupNo.name = "redeploy-backup";
  backupNo.value = "no";
  backupNo.onchange = () => updateGPGVisibility();

  const backupLabelYes = document.createElement("label");
  backupLabelYes.style.display = "block";
  backupLabelYes.style.fontWeight = "normal";
  backupLabelYes.append(backupYes, " Back up the live database first");
  const backupLabelNo = document.createElement("label");
  backupLabelNo.style.display = "block";
  backupLabelNo.style.fontWeight = "normal";
  backupLabelNo.append(backupNo, " Skip backup");

  const gpgPassphraseField = createSecretField(
    "GPG_PASSPHRASE (only if backing up)",
    "password",
    () => render(),
    () => {
      gpgConfirmInput.value = gpgPassphraseField.input.value;
      render();
    },
  );
  const gpgPassphraseWrap = gpgPassphraseField.wrap;
  const gpgPassphraseInput = gpgPassphraseField.input;

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

  const remember = createRememberCheckbox((on) => gpgPassphraseField.refreshTypedHint(on));

  let gpgKeyringTried = false;
  async function fillGPGFromKeyring() {
    if (gpgKeyringTried || gpgPassphraseInput.value) return;
    gpgKeyringTried = true;
    try {
      const { env, keyring } = await loadSecrets([]);
      gpgPassphraseField.applyLoaded(env.gpgPassphrase ?? "", keyring.gpgPassphrase ?? "");
    } catch {
      // Keyring unavailable — type the passphrase this run.
    }
  }

  function applyGPGVisibility() {
    const show = backupYes.checked;
    sshKeyWrap.style.display = show ? "" : "none";
    gpgPassphraseWrap.style.display = show ? "" : "none";
    gpgConfirmWrap.style.display = show ? "" : "none";
    remember.el.style.display = show ? "" : "none";
  }

  function updateGPGVisibility() {
    if (!backupYes.checked) {
      gpgPassphraseInput.value = "";
      gpgConfirmInput.value = "";
    }
    applyGPGVisibility();
    render();
  }

  function gpgMismatch(): boolean {
    return backupYes.checked && gpgPassphraseInput.value !== gpgConfirmInput.value;
  }

  // --- options + run -------------------------------------------------------------

  const forceRebuildCheck = document.createElement("input");
  forceRebuildCheck.type = "checkbox";
  const forceRebuildLabel = document.createElement("label");
  forceRebuildLabel.style.display = "block";
  forceRebuildLabel.style.fontWeight = "normal";
  forceRebuildLabel.append(forceRebuildCheck, " Force a full rebuild (ignore App Platform's build cache)");

  const redeployButton = document.createElement("button");
  redeployButton.textContent = "Redeploy";
  redeployButton.style.marginTop = "0.5rem";

  // Stays clickable even while the rest of the panel is disabled (e.g.
  // preflight failing) — it's just inspecting files, not redeploying anything.
  const openBackupsButton = document.createElement("button");
  openBackupsButton.type = "button";
  openBackupsButton.className = "secondary";
  openBackupsButton.textContent = "Open backups folder";
  openBackupsButton.style.pointerEvents = "auto";
  openBackupsButton.onclick = () => void openBackupsFolder(state.opsDir, state.appName);

  const actionRow = document.createElement("div");
  actionRow.className = "row";
  actionRow.append(openBackupsButton, redeployButton);

  const status = document.createElement("div");
  status.className = "status-line";

  const runSummary = createRunSummary("redeploy");

  // redeploy.sh can run for several games at once (see scriptrunner.go) — this
  // pane just re-points at whichever game is currently selected.
  const logPane = createLogPane("redeploy", (info) => {
    if (info.appName !== state.appName) return;
    void (async () => {
      // refreshStatus also re-runs the code check. DO can lag a few seconds
      // behind a rollout that just finished, so check once more after it has
      // settled rather than risk re-announcing the code just deployed.
      await refreshStatus();
      render();
      notify();
      setTimeout(() => {
        if (state.appName === info.appName) void refreshCodeCheck();
      }, 8000);
    })();
  });

  redeployButton.onclick = async () => {
    if (!state.appName || !state.opsDir) return;
    const appName = state.appName;
    const backup = backupYes.checked ? "yes" : "no";
    const sshKeyName = sshKeySelect.value;
    const gpgPassphrase = gpgPassphraseInput.value;
    const forceRebuild = forceRebuildCheck.checked;
    const check = currentCodeCheck();
    const sqlHits = check?.destructiveSql ?? [];

    // Mark this game as running immediately (before the first log line
    // arrives) so the button/tab reflect it right away, and record what it's
    // running with — same rows and wording as the Deploy panel's summary
    // (secrets only as "✓ set"/"✗ not set", never their values).
    clearGameRun("redeploy", appName);
    const run = getGameRun("redeploy", appName);
    run.running = true;
    const conf = state.deployConf;
    const setMark = (value: string) => (value ? "✓ set" : "✗ not set");
    let commit = "latest commit of the branch (not compared with what's deployed)";
    if (check?.state === "behind") {
      commit = `${shortSha(check.deployed)} → ${shortSha(check.latest)} (${commitsText(check.commits)})`;
    } else if (check?.state === "current") {
      commit = `${shortSha(check.deployed)} (already the latest — redeploying the same commit)`;
    }
    let sql = "not checked";
    if (sqlHits.length > 0) {
      sql = `${sqlHits.length} flagged line${sqlHits.length === 1 ? "" : "s"} — reviewed`;
    } else if (check?.state === "behind" && check.commits >= 0) {
      sql = "none flagged";
    } else if (check?.state === "current") {
      sql = "none (no new commits)";
    }
    run.params = [
      ["App name", conf?.appName || appName],
      ["Git repo", conf?.gitRepo || "—"],
      ["Git branch", check?.branch || conf?.gitBranch || "repo default"],
      ...(conf?.gitUpstream ? [["Upstream", conf.gitUpstream] as [string, string]] : []),
      ["Env var prefix", conf?.envVarPrefix || "—"],
      ["Database", conf?.dbName || "—"],
      ["HTTP port", conf?.httpPort || "—"],
      ["Commit", commit],
      ["Destructive SQL", sql],
      ["Back up database first", backup === "yes" ? "yes" : "no"],
      ...(backup === "yes"
        ? [
            ["SSH key", sshKeyName] as [string, string],
            ["GPG_PASSPHRASE", setMark(gpgPassphrase)] as [string, string],
          ]
        : []),
      ["Full rebuild", forceRebuild ? "yes (no build cache)" : "no (reuse build cache)"],
      ["App spec", "unchanged (env vars, app size, branch stay as deployed)"],
    ];
    redeployButton.disabled = true;
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
        // Don't block the redeploy if the keychain write fails.
      }
    }
    if (!s.rememberSecrets) {
      gpgPassphraseField.reset();
      gpgConfirmInput.value = "";
    }
    notify();

    await runRedeploy({
      opsDir: state.opsDir,
      appName,
      backup,
      sshKeyName: backup === "yes" ? sshKeyName : "",
      gpgPassphrase,
      forceRebuild,
    });
  };

  // Hidden while a redeploy is in flight, like the other panels: a run you
  // switch back to should show progress, not a form implying it hasn't started.
  const formParts = [
    sshKeyWrap,
    backupLabelYes,
    backupLabelNo,
    gpgPassphraseWrap,
    gpgConfirmWrap,
    gpgMismatchWarning,
    remember.el,
    forceRebuildLabel,
    actionRow,
  ];

  el.append(
    intro,
    codeRow,
    sqlBox,
    sshKeyWrap,
    backupLabelYes,
    backupLabelNo,
    gpgPassphraseWrap,
    gpgConfirmWrap,
    gpgMismatchWarning,
    remember.el,
    forceRebuildLabel,
    actionRow,
    runSummary.el,
    logPane.el,
    status,
  );

  updateGPGVisibility();

  function codeLineText(): string {
    const c = state.codeCheck && state.codeCheck.appName === state.appName ? state.codeCheck : null;
    if (!c) return "Code check hasn't run yet.";
    const r = c.result;
    if (!r) {
      if (c.checking) return "Checking for new code…";
      return c.error ? `Couldn't check for new code: ${c.error}` : "Code check hasn't run yet.";
    }
    let text: string;
    switch (r.state) {
      case "behind":
        text = `New code on ${r.branch}: ${commitsText(r.commits)} (${shortSha(r.deployed)} → ${shortSha(r.latest)}) not deployed yet.`;
        break;
      case "current":
        text = `Up to date — ${shortSha(r.deployed)} is the latest on ${r.branch}. You can still redeploy it (e.g. to restart the app or rebuild).`;
        break;
      case "no-app":
        text = "No app is deployed for this game.";
        break;
      default:
        text = `Couldn't compare with the latest code${r.note ? `: ${r.note}` : ""}.`;
    }
    if (c.checking) text += " Re-checking…";
    else if (c.error) text += ` (Last re-check failed: ${c.error})`;
    return text;
  }

  function render() {
    // A deploy or teardown in flight owns the Action tab; otherwise this panel
    // is offered whenever there's a deployed app to redeploy and the Manage
    // tab's switch is on Redeploy (see manageSwitch.ts).
    const running = isGameRunning("redeploy", state.appName);
    const otherRunning = isGameRunning("create", state.appName) || isGameRunning("delete", state.appName);
    const show =
      Boolean(state.appName) &&
      !otherRunning &&
      manageMode() === "redeploy" &&
      (running || state.status?.appExists === true);
    el.style.display = show ? "" : "none";
    if (!show) return;

    remember.sync(state.appName);
    logPane.showGame(state.appName);
    runSummary.render(state.appName, { running: "Redeploying", done: "Redeployed" });
    for (const part of formParts) part.style.display = running ? "none" : "";
    codeRow.style.display = running ? "none" : "";

    const check = currentCodeCheck();
    const sqlHits = check?.state === "behind" ? check.destructiveSql : [];
    const couldntCompare = check?.state === "behind" && Boolean(check.note);
    if (check && ackFor !== check.latest) {
      ackFor = check.latest;
      ackCheck.checked = false;
    }
    const needsAck = sqlHits.length > 0;
    sqlBox.style.display = !running && (needsAck || couldntCompare) ? "" : "none";
    sqlHeading.textContent = needsAck
      ? "The new commits add SQL that removes or rewrites data or columns:"
      : "Couldn't check the new commits for destructive SQL.";
    sqlList.innerHTML = "";
    sqlList.style.display = needsAck ? "" : "none";
    for (const hit of sqlHits) {
      const li = document.createElement("li");
      li.textContent = hit;
      sqlList.appendChild(li);
    }
    sqlNote.textContent = needsAck
      ? "It runs against the live database when the new build starts. If that build then fails, the old version keeps serving but may break against the changed schema — the backup is the only way back." +
        (backupNo.checked ? " Backup is switched off, so nothing can undo these changes." : "")
      : (check?.note ?? "");
    ackLabel.style.display = needsAck ? "" : "none";

    codeLine.textContent = codeLineText();
    const checking = state.codeCheck?.appName === state.appName && state.codeCheck.checking;
    checkButton.disabled = Boolean(checking);

    if (!running) {
      applyGPGVisibility();
      void fillGPGFromKeyring();
      if (state.opsDir && keysLoadedForOpsDir !== state.opsDir) {
        keysLoadedForOpsDir = state.opsDir;
        void refreshKeys();
      }
    }

    const ready = Boolean(state.opsDir && preflightPassed());
    // See deployPanel.ts's identical comment: don't dim the log/summary the
    // operator is watching just because the (hidden) form beneath it isn't ready.
    el.dataset.disabled = !running && !ready ? "true" : "false";
    const mismatch = gpgMismatch();
    const missingKey = backupYes.checked && !sshKeySelect.value;
    const unacknowledged = needsAck && !ackCheck.checked;
    redeployButton.disabled = !ready || running || mismatch || missingKey || unacknowledged;
    gpgMismatchWarning.textContent = mismatch ? "GPG_PASSPHRASE and its confirmation don't match." : "";
    if (!preflightPassed()) {
      status.textContent = "Fix the failing Prerequisites checks above before redeploying.";
    } else if (unacknowledged) {
      status.textContent = "Tick the box above to confirm you've reviewed the SQL changes.";
    } else {
      status.textContent = "";
    }
  }

  render();
  return { el, render };
}
