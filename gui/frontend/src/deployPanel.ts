import {
  hasBackups,
  listAvailableRegions,
  listAvailableTiers,
  listSSHKeys,
  loadSecrets,
  loadSettings,
  openBackupsFolder,
  runCreate,
  saveSecrets,
  forgetSecrets,
  setRememberSecrets,
  type ExtraEnvVar,
  type RegionOption,
  type TierOption,
} from "./api";
import { createLogPane } from "./logPane";
import { refreshStatus, scheduleStatusReconcile } from "./appPanel";
import { state, preflightPassed, isDeployed, isGameRunning, hasFailedExit, hasCreateLog, getGameRun, clearGameRun, notify } from "./state";
import { createRunSummary } from "./runSummary";
import { resolveExtraEnvNames } from "./extraEnv";

export function createDeployPanel(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.innerHTML = `<p class="hint">Creates the droplet + app for this game, restoring the latest backup if one exists.</p>`;

  const sshKeyWrap = document.createElement("div");
  sshKeyWrap.className = "field";
  const sshKeyLabel = document.createElement("label");
  sshKeyLabel.textContent = "SSH key";
  const sshKeyRow = document.createElement("div");
  sshKeyRow.className = "row";
  const sshKeySelect = document.createElement("select");
  const refreshKeysButton = document.createElement("button");
  refreshKeysButton.type = "button";
  refreshKeysButton.className = "secondary";
  refreshKeysButton.textContent = "Refresh";
  refreshKeysButton.onclick = () => void refreshKeys();
  sshKeyRow.append(sshKeySelect, refreshKeysButton);
  sshKeyWrap.append(sshKeyLabel, sshKeyRow);

  // Region override: defaults to deploy.conf's DROPLET_REGION, but since
  // the tier sizes aren't sold everywhere (and the nyc3 default sells none
  // of them), the operator needs to be able to pick another region without
  // leaving the Deploy tab. Passed to create.sh as --region, which never
  // rewrites deploy.conf — the Config tab is still where it's made permanent.
  const regionWrap = document.createElement("div");
  regionWrap.className = "field";
  const regionLabel = document.createElement("label");
  regionLabel.textContent = "Region";
  const regionRow = document.createElement("div");
  regionRow.className = "row";
  const regionSelect = document.createElement("select");
  regionSelect.onchange = () => void refreshTiers();
  regionRow.append(regionSelect);
  const regionStatus = document.createElement("div");
  regionStatus.className = "hint";
  regionWrap.append(regionLabel, regionRow, regionStatus);

  const tierWrap = document.createElement("div");
  tierWrap.className = "field";
  const tierLabel = document.createElement("label");
  tierLabel.textContent = "Price tier";
  const tierLabelRow = document.createElement("div");
  tierLabelRow.className = "row";
  const refreshTiersButton = document.createElement("button");
  refreshTiersButton.type = "button";
  refreshTiersButton.className = "secondary";
  refreshTiersButton.textContent = "Refresh";
  refreshTiersButton.onclick = () => void refreshRegions().then(refreshTiers);
  tierLabelRow.append(tierLabel, refreshTiersButton);
  const tierWrapper = document.createElement("div");
  const tierStatus = document.createElement("div");
  tierStatus.className = "hint";
  let tierInputs: HTMLInputElement[] = [];
  // Tiers are region-specific (create.sh checks deploy.conf's
  // DROPLET_REGION), so they're refetched whenever the selected game
  // changes rather than kept static — see refreshTiers()/render() below.
  let tiersLoadedForApp = "";
  let tierCheckToken = 0;
  tierWrap.append(tierLabelRow, tierWrapper, tierStatus);

  const sqlUserWrap = document.createElement("div");
  sqlUserWrap.className = "field";
  const sqlUserLabel = document.createElement("label");
  sqlUserLabel.textContent = "DEPLOY_SQL_USER";
  const sqlUserInput = document.createElement("input");
  sqlUserInput.oninput = () => void render();
  sqlUserWrap.append(sqlUserLabel, sqlUserInput);

  const sqlPasswordWrap = document.createElement("div");
  sqlPasswordWrap.className = "field";
  const sqlPasswordLabel = document.createElement("label");
  sqlPasswordLabel.textContent = "DEPLOY_SQL_PASSWORD";
  const sqlPasswordInput = document.createElement("input");
  sqlPasswordInput.type = "password";
  sqlPasswordInput.oninput = () => void render();
  sqlPasswordWrap.append(sqlPasswordLabel, sqlPasswordInput);

  const gpgPassphraseWrap = document.createElement("div");
  gpgPassphraseWrap.className = "field";
  const gpgPassphraseLabel = document.createElement("label");
  gpgPassphraseLabel.textContent = "GPG_PASSPHRASE (only if restoring a backup)";
  const gpgPassphraseInput = document.createElement("input");
  gpgPassphraseInput.type = "password";
  gpgPassphraseWrap.append(gpgPassphraseLabel, gpgPassphraseInput);

  // Extra secrets named in deploy.conf EXTRA_ENV_VARS — names are not
  // secret and come from config; values are typed here at deploy time.
  // With "Remember on this computer" they live in the OS keyring, not
  // deploy.conf / settings.json.
  const extraEnvWrap = document.createElement("div");
  extraEnvWrap.className = "field-grid";
  extraEnvWrap.style.display = "none";
  const extraEnvInputs = new Map<string, HTMLInputElement>();
  let extraEnvFor = "";

  function extraEnvNames(): string[] {
    return resolveExtraEnvNames(
      state.deployConf?.extraEnvVars ?? "",
      state.deployConf?.envVarPrefix ?? "",
    );
  }

  function rebuildExtraEnvFields() {
    const names = extraEnvNames();
    const key = `${state.appName}\0${names.join(" ")}`;
    if (key === extraEnvFor) return;
    extraEnvFor = key;
    extraEnvWrap.innerHTML = "";
    extraEnvInputs.clear();
    extraEnvWrap.style.display = names.length ? "" : "none";
    for (const name of names) {
      const wrap = document.createElement("div");
      wrap.className = "field";
      const label = document.createElement("label");
      label.textContent = name;
      const input = document.createElement("input");
      input.type = "password";
      input.oninput = () => void render();
      wrap.append(label, input);
      extraEnvWrap.appendChild(wrap);
      extraEnvInputs.set(name, input);
    }
    void fillSecrets();
  }

  async function fillSecrets() {
    try {
      const bundle = await loadSecrets(extraEnvNames());
      if (!sqlUserInput.value) sqlUserInput.value = bundle.sqlUser ?? "";
      if (!sqlPasswordInput.value) sqlPasswordInput.value = bundle.sqlPassword ?? "";
      if (!gpgPassphraseInput.value) gpgPassphraseInput.value = bundle.gpgPassphrase ?? "";
      const extras = bundle.extraEnv ?? [];
      for (const ev of extras) {
        const input = extraEnvInputs.get(ev.key);
        if (input && !input.value && ev.value) input.value = ev.value;
      }
      void render();
    } catch {
      // Shouldn't happen — LoadSecrets falls back to env if the keyring is
      // unavailable. Leave fields empty so the operator can still type.
    }
  }

  const backupWarning = document.createElement("div");
  backupWarning.className = "status-line";

  const rememberWrap = document.createElement("div");
  rememberWrap.className = "field";
  const rememberLabel = document.createElement("label");
  rememberLabel.className = "extra-env-check";
  const rememberCheck = document.createElement("input");
  rememberCheck.type = "checkbox";
  rememberLabel.append(rememberCheck, document.createTextNode(" Remember secrets on this computer"));
  const rememberHint = document.createElement("p");
  rememberHint.className = "hint";
  rememberHint.textContent =
    "Empty fields are filled from your environment (DEPLOY_SQL_USER, extra API keys, GPG_PASSPHRASE) if set — including WSL on Windows. Check the box to also save them in the OS keychain, not in the repo or deploy.conf.";
  const rememberStatus = document.createElement("div");
  rememberStatus.className = "status-line";
  const forgetButton = document.createElement("button");
  forgetButton.type = "button";
  forgetButton.className = "secondary";
  forgetButton.textContent = "Forget saved secrets";
  rememberWrap.append(rememberLabel, rememberHint, rememberStatus, forgetButton);

  void loadSettings().then((s) => {
    rememberCheck.checked = Boolean(s.rememberSecrets);
  });
  rememberCheck.onchange = () => {
    void setRememberSecrets(rememberCheck.checked).catch((err) => {
      rememberStatus.textContent = `Couldn't save preference: ${err instanceof Error ? err.message : String(err)}`;
    });
  };
  forgetButton.onclick = async () => {
    rememberStatus.textContent = "";
    try {
      await forgetSecrets(extraEnvNames());
      sqlUserInput.value = "";
      sqlPasswordInput.value = "";
      gpgPassphraseInput.value = "";
      for (const input of extraEnvInputs.values()) {
        input.value = "";
      }
      rememberStatus.textContent = "Saved secrets removed from the OS keychain.";
      void render();
    } catch (err) {
      rememberStatus.textContent = `Couldn't forget secrets: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  const openBackupsButton = document.createElement("button");
  openBackupsButton.type = "button";
  openBackupsButton.className = "secondary";
  openBackupsButton.textContent = "Open backups folder";
  // Stays clickable even while the rest of the panel is disabled (e.g.
  // preflight failing) — it's just inspecting files, not deploying.
  openBackupsButton.style.pointerEvents = "auto";
  openBackupsButton.onclick = () => void openBackupsFolder(state.opsDir, state.appName);

  const deployButton = document.createElement("button");
  deployButton.textContent = "Deploy";

  // create.sh can run for several games at once (see scriptrunner.go) — this
  // pane just re-points at whichever game is currently selected; a game
  // deploying in the background keeps streaming into its own buffered
  // history even while a different game is on screen.
  const logPane = createLogPane("create", (info) => {
    // deployButton's own enabled state is recomputed in render() below —
    // fields were cleared when the run started, so formFilled() correctly
    // keeps it disabled until the operator refills them for another attempt.
    // Only touch global status if this finish is for the game currently on
    // screen — a background game's status gets rechecked fresh whenever the
    // operator selects it (see appPanel.ts's chooseApp).
    if (info.appName !== state.appName) return;
    void (async () => {
      // On success we already know the outcome — create.sh just finished
      // creating the droplet + app — so set status directly rather than
      // re-querying doctl immediately after, which can still report the old
      // state for a few seconds (DO API eventual consistency). Only a
      // failure (partial/unknown state) needs a real re-check.
      if (info.code === 0) {
        // Re-query to pick up the new app's ingress URL, but keep the
        // deployed flags forced on: doctl can still report the old state for
        // a few seconds (DO API eventual consistency), and we already know
        // create.sh just finished successfully.
        await refreshStatus();
        state.status = { dropletExists: true, appExists: true, appURL: state.status?.appURL ?? "" };
        // Whatever teardown history existed for this game was for a
        // deployment that no longer exists — a successful deploy makes it
        // stale, and leaving it in place is what made switching to
        // Teardown right after deploying show an unrelated old run.
        clearGameRun("delete", info.appName);
      } else {
        await refreshStatus();
      }
      void render();
      notify();
      // Also picks up the app's ingress URL if DO hadn't assigned one yet
      // when the status above was read.
      scheduleStatusReconcile(info.appName);
    })();
  });

  deployButton.onclick = async () => {
    if (!state.appName || !state.opsDir) return;
    const appName = state.appName;
    const tier = tierInputs.find((i) => i.checked)?.value ?? "";
    const sshKeyName = sshKeySelect.value;
    const sqlUser = sqlUserInput.value;
    const sqlPassword = sqlPasswordInput.value;
    const gpgPassphrase = gpgPassphraseInput.value;
    const extraEnv: ExtraEnvVar[] = [];
    for (const [name, input] of extraEnvInputs) {
      extraEnv.push({ key: name, value: input.value });
    }

    if (rememberCheck.checked) {
      try {
        await saveSecrets({
          sqlUser,
          sqlPassword,
          gpgPassphrase,
          extraEnv,
        });
        rememberStatus.textContent = "";
      } catch (err) {
        rememberStatus.textContent = `Couldn't save to the OS keychain: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Mark this game as running immediately (before the first log line
    // arrives) so the button/tab reflect it right away, and record the
    // non-secret settings it's running with for the progress view.
    clearGameRun("create", appName);
    const run = getGameRun("create", appName);
    run.running = true;
    run.params = [
      ["SSH key", sshKeyName],
      ["Region", regionSelect.value],
      ["Price tier", tierInputs.find((i) => i.checked)?.parentElement?.textContent?.trim() ?? tier],
    ];
    deployButton.disabled = true;

    // Drop secrets from the DOM unless they were just written to the OS
    // keychain — then they stay filled so a retry doesn't require retyping.
    if (!rememberCheck.checked) {
      sqlUserInput.value = "";
      sqlPasswordInput.value = "";
      gpgPassphraseInput.value = "";
      for (const input of extraEnvInputs.values()) {
        input.value = "";
      }
    }
    notify();

    await runCreate({
      opsDir: state.opsDir,
      appName,
      sshKeyName,
      tier,
      region: regionSelect.value,
      autoYes: true,
      sqlUser,
      sqlPassword,
      gpgPassphrase,
      extraEnv,
    });
  };

  const credsGrid = document.createElement("div");
  credsGrid.className = "field-grid";
  credsGrid.append(sqlUserWrap, sqlPasswordWrap, gpgPassphraseWrap);

  const actionRow = document.createElement("div");
  actionRow.className = "row";
  actionRow.append(openBackupsButton, deployButton);

  // Shown instead of the form once a failed deploy has been torn down — see
  // the "resolved" case in render() below. Clearing the run here is an
  // explicit operator action (as opposed to teardownPanel.ts clearing it
  // automatically), so the failure stays visible — summary, params, and
  // log — until the operator has actually looked at it and is ready to
  // fill in a fresh attempt.
  const startNewRow = document.createElement("div");
  startNewRow.className = "row";
  const startNewButton = document.createElement("button");
  startNewButton.type = "button";
  startNewButton.className = "secondary";
  startNewButton.textContent = "Start New Deploy";
  startNewButton.onclick = () => {
    clearGameRun("create", state.appName);
    notify();
  };
  startNewRow.append(startNewButton);

  const runSummary = createRunSummary("create");

  // Everything the operator fills in — hidden while a run is in flight, so
  // switching back to a deploying game shows its progress rather than an
  // inert form implying it hasn't started.
  const formParts = [sshKeyWrap, regionWrap, tierWrap, credsGrid, extraEnvWrap, rememberWrap, backupWarning, actionRow];

  el.append(
    sshKeyWrap,
    regionWrap,
    tierWrap,
    credsGrid,
    extraEnvWrap,
    rememberWrap,
    backupWarning,
    actionRow,
    startNewRow,
    runSummary.el,
    logPane.el,
  );

  async function refreshKeys() {
    sshKeySelect.innerHTML = "";
    const keys = await listSSHKeys();
    for (const key of keys) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = key;
      sshKeySelect.appendChild(opt);
    }
  }

  // Populates regionSelect with the regions create.sh reports as offering
  // at least one tier, preselecting deploy.conf's DROPLET_REGION (or the
  // nyc3 default) when it's among them.
  async function refreshRegions() {
    if (!state.opsDir || !state.appName) return;
    const configured = state.deployConf?.dropletRegion?.trim() || "nyc3";
    regionStatus.textContent = "Loading regions…";

    let regions: RegionOption[] = [];
    try {
      regions = (await listAvailableRegions(state.opsDir, state.appName)) ?? [];
    } catch (err) {
      // Clear both lists: an unknown region set means the tiers currently
      // on screen (if any) describe a region we can no longer vouch for.
      regionSelect.innerHTML = "";
      clearTiers();
      tierStatus.textContent = "";
      regionStatus.textContent = `Could not load regions: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    regionSelect.innerHTML = "";

    // The configured region is always the selected one, even when it offers
    // nothing — silently deploying somewhere the operator didn't choose is
    // a real change (latency, cost, data residency), and pairing that with
    // a populated tier list reads as "the configured region has tiers". It
    // gets listed as an explicitly unavailable option instead, so the empty
    // tier list below is clearly about the region on screen.
    const configuredIsAvailable = regions.some((r) => r.slug === configured);
    if (!configuredIsAvailable) {
      const opt = document.createElement("option");
      opt.value = configured;
      opt.textContent = `${configured} — no matching tiers`;
      regionSelect.appendChild(opt);
    }
    for (const region of regions) {
      const opt = document.createElement("option");
      opt.value = region.slug;
      opt.textContent = `${region.slug} — ${region.name}`;
      regionSelect.appendChild(opt);
    }

    regionSelect.value = configured;
    if (configuredIsAvailable) {
      regionStatus.textContent = "";
    } else if (regions.length > 0) {
      regionStatus.textContent = `deploy.conf's region (${configured}) doesn't offer any of these droplet sizes. Pick another region above to deploy there this time, or set DROPLET_REGION in the Config tab to change it permanently.`;
    } else {
      clearTiers();
      tierStatus.textContent = "";
      regionStatus.textContent = "No regions offering these tiers were found.";
    }
  }

  function clearTiers() {
    tierWrapper.innerHTML = "";
    tierInputs = [];
  }

  // Populates tierWrapper with a radio button per tier create.sh's
  // --list-tiers reports as available in the selected region. Preserves the
  // previously-checked tier across a refresh when it's still on offer, so
  // re-checking availability doesn't silently clear the operator's choice.
  async function refreshTiers() {
    if (!state.opsDir || !state.appName) return;
    tiersLoadedForApp = state.appName;
    const previouslyChecked = tierInputs.find((i) => i.checked)?.value;
    refreshTiersButton.disabled = true;
    // Each check is stamped so a slow one that resolves after the operator
    // has already switched region (or game) can't repopulate the radios
    // with tiers for the region they moved away from.
    const token = ++tierCheckToken;
    const checkedRegion = regionSelect.value;
    clearTiers();
    tierStatus.textContent = "Checking tier availability…";

    let tiers: TierOption[] = [];
    try {
      tiers = (await listAvailableTiers(state.opsDir, state.appName, checkedRegion)) ?? [];
    } catch (err) {
      if (token !== tierCheckToken) return;
      clearTiers();
      tierStatus.textContent = `Could not check tier availability: ${err instanceof Error ? err.message : String(err)}`;
      refreshTiersButton.disabled = false;
      void render();
      return;
    }
    if (token !== tierCheckToken) return;

    clearTiers();
    for (const tier of tiers) {
      const label = document.createElement("label");
      label.style.fontWeight = "normal";
      label.style.textTransform = "none";
      label.style.display = "block";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "tier";
      input.value = String(tier.number);
      input.checked = String(tier.number) === previouslyChecked;
      input.onchange = () => void render();
      tierInputs.push(input);
      label.appendChild(input);
      label.append(` ${tier.number}) ${tier.label}`);
      tierWrapper.appendChild(label);
    }
    const region = regionSelect.value || state.deployConf?.dropletRegion?.trim() || "nyc3 (default)";
    tierStatus.textContent =
      tiers.length > 0 ? "" : `No price tiers are available in region ${region} — pick another region above.`;
    refreshTiersButton.disabled = false;
    void render();
  }

  function formFilled(): boolean {
    const tierChosen = tierInputs.some((i) => i.checked);
    if (!tierChosen || sqlUserInput.value.trim() === "" || sqlPasswordInput.value.trim() === "") {
      return false;
    }
    for (const input of extraEnvInputs.values()) {
      if (input.value.trim() === "") return false;
    }
    return true;
  }

  async function render() {
    // A create run in flight wins over Digital Ocean's status: mid-deploy
    // the droplet exists before the app does, so status alone reads as
    // "deployed" and this panel would hand over to Teardown partway through
    // its own run.
    const running = isGameRunning("create", state.appName);
    const deleting = isGameRunning("delete", state.appName);
    const deployed = isDeployed() === true;
    const failedCreate = hasFailedExit("create", state.appName);
    // Keep this panel (and its log) visible after a create finishes —
    // otherwise isDeployed() hides the log and swaps to empty Teardown.
    const show =
      Boolean(state.appName) &&
      !deleting &&
      (running || failedCreate || hasCreateLog(state.appName) || !deployed);
    el.style.display = show ? "" : "none";
    if (!show) return;

    logPane.showGame(state.appName);
    runSummary.render(state.appName, { running: "Deploying", done: "Deployed" });
    rebuildExtraEnvFields();
    // A failed create whose cloud resources have since been torn down
    // (teardownPanel.ts keeps this record instead of clearing it — see its
    // comment) is its own state: distinct from a failed create that still
    // has a droplet sitting around (form stays usable there, unchanged), and
    // from a fresh/never-run game (form should just show). Here the operator
    // has already cleaned up; showing the fillable form back immediately
    // reads as "nothing happened" and invites hitting Deploy again without
    // ever having seen why it failed. Start New Deploy is the one way out.
    const resolved = failedCreate && !deployed;
    const hideForm = running || (deployed && !failedCreate) || resolved;
    for (const part of formParts) part.style.display = hideForm ? "none" : "";
    startNewRow.style.display = resolved ? "" : "none";

    // Skip the availability checks entirely while the form is hidden — a
    // run in flight, or a finished create whose log we're still showing.
    if (!hideForm && state.appName !== tiersLoadedForApp) {
      tiersLoadedForApp = state.appName;
      void refreshRegions().then(refreshTiers);
    }
    const ready = Boolean(state.deployConfFound && state.opsDir && preflightPassed());
    // Dims the whole panel (including the log) when the form is shown but
    // not fillable yet — e.g. preflight failing. Not applied while the form
    // is hidden: there's no reason to grey out the log the operator is
    // watching just because the (hidden) form beneath it isn't ready.
    el.dataset.disabled = !hideForm && !ready ? "true" : "false";
    deployButton.disabled = !ready || running || !formFilled();

    if (hideForm) return;
    if (!state.deployConfFound) {
      backupWarning.textContent = "Fill in the Config tab before deploying.";
    } else if (!preflightPassed()) {
      backupWarning.textContent = "Fix the failing Prerequisites checks above before deploying.";
    } else {
      const ok = await hasBackups(state.opsDir, state.appName);
      backupWarning.textContent = ok ? "" : "No backups/*.gpg found for this game — deploy will fail without one.";
    }
  }

  void refreshKeys();
  void render();
  return { el, render: () => void render() };
}
