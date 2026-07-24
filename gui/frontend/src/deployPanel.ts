import {
  hasBackups,
  listAvailableRegions,
  listAvailableTiers,
  listSSHKeys,
  openBackupsFolder,
  runCreate,
  type RegionOption,
  type TierOption,
} from "./api";
import { createLogPane } from "./logPane";
import { refreshStatus } from "./appPanel";
import { state, preflightPassed, isDeployed, isGameRunning, getGameRun, notify } from "./state";
import { createRunSummary } from "./runSummary";

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

  const backupWarning = document.createElement("div");
  backupWarning.className = "status-line";

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
      } else {
        await refreshStatus();
      }
      void render();
      notify();
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

    // Mark this game as running immediately (before the first log line
    // arrives) so the button/tab reflect it right away, and record the
    // non-secret settings it's running with for the progress view.
    const run = getGameRun("create", appName);
    run.running = true;
    // Clear the previous run's exit so the summary reads as in-progress
    // rather than reporting a stale result. The log lines are intentionally
    // kept: logPane appends incrementally and only redraws on a game
    // switch, so emptying them here would desync it from the DOM.
    run.lastExit = undefined;
    run.params = [
      ["SSH key", sshKeyName],
      ["Region", regionSelect.value],
      ["Price tier", tierInputs.find((i) => i.checked)?.parentElement?.textContent?.trim() ?? tier],
    ];
    deployButton.disabled = true;

    // Clear secret fields from memory immediately once the run has been
    // handed off — they're never persisted to disk.
    sqlUserInput.value = "";
    sqlPasswordInput.value = "";
    gpgPassphraseInput.value = "";
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
    });
  };

  const credsGrid = document.createElement("div");
  credsGrid.className = "field-grid";
  credsGrid.append(sqlUserWrap, sqlPasswordWrap, gpgPassphraseWrap);

  const actionRow = document.createElement("div");
  actionRow.className = "row";
  actionRow.append(openBackupsButton, deployButton);

  const runSummary = createRunSummary("create");

  // Everything the operator fills in — hidden while a run is in flight, so
  // switching back to a deploying game shows its progress rather than an
  // inert form implying it hasn't started.
  const formParts = [sshKeyWrap, regionWrap, tierWrap, credsGrid, backupWarning, actionRow];

  el.append(sshKeyWrap, regionWrap, tierWrap, credsGrid, backupWarning, actionRow, runSummary.el, logPane.el);

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
    for (const region of regions) {
      const opt = document.createElement("option");
      opt.value = region.slug;
      opt.textContent = `${region.slug} — ${region.name}`;
      regionSelect.appendChild(opt);
    }

    // The configured region often isn't in the list — that's the whole
    // reason this dropdown exists (nyc3 sells none of these sizes) — so
    // fall back to the first region that does work rather than showing a
    // selection that can't deploy.
    if (regions.some((r) => r.slug === configured)) {
      regionSelect.value = configured;
      regionStatus.textContent = "";
    } else if (regions.length > 0) {
      regionSelect.value = regions[0].slug;
      regionStatus.textContent = `deploy.conf's region (${configured}) offers none of these tiers — using ${regionSelect.value} for this deploy. Set DROPLET_REGION in the Config tab to make it permanent.`;
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
    return tierChosen && sqlUserInput.value.trim() !== "" && sqlPasswordInput.value.trim() !== "";
  }

  async function render() {
    // A create run in flight wins over Digital Ocean's status: mid-deploy
    // the droplet exists before the app does, so status alone reads as
    // "deployed" and this panel would hand over to Teardown partway through
    // its own run.
    const running = isGameRunning("create", state.appName);
    const deleting = isGameRunning("delete", state.appName);
    const show = Boolean(state.appName) && !deleting && (running || isDeployed() !== true);
    el.style.display = show ? "" : "none";
    if (!show) return;

    logPane.showGame(state.appName);
    runSummary.render(state.appName, { running: "Deploying", done: "Deployed" });
    for (const part of formParts) part.style.display = running ? "none" : "";

    // Skip the availability checks entirely while a run is in flight — the
    // form is hidden, and each check spawns its own script invocation.
    if (!running && state.appName !== tiersLoadedForApp) {
      tiersLoadedForApp = state.appName;
      void refreshRegions().then(refreshTiers);
    }
    const ready = Boolean(state.deployConfFound && state.opsDir && preflightPassed());
    el.dataset.disabled = ready && !running ? "false" : "true";
    deployButton.disabled = !ready || running || !formFilled();

    if (running) return; // the form (and this warning) is hidden anyway
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
