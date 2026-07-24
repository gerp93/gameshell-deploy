import { hasBackups, listAvailableTiers, listSSHKeys, openBackupsFolder, runCreate, type TierOption } from "./api";
import { createLogPane } from "./logPane";
import { refreshStatus } from "./appPanel";
import { state, preflightPassed, isDeployed, isGameRunning, getGameRun, notify } from "./state";

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
  refreshTiersButton.onclick = () => void refreshTiers();
  tierLabelRow.append(tierLabel, refreshTiersButton);
  const tierWrapper = document.createElement("div");
  const tierStatus = document.createElement("div");
  tierStatus.className = "hint";
  let tierInputs: HTMLInputElement[] = [];
  // Tiers are region-specific (create.sh checks deploy.conf's
  // DROPLET_REGION), so they're refetched whenever the selected game
  // changes rather than kept static — see refreshTiers()/render() below.
  let tiersLoadedForApp = "";
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
        state.status = { dropletExists: true, appExists: true };
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
    // arrives) so the button/tab reflect it right away.
    getGameRun("create", appName).running = true;
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

  el.append(sshKeyWrap, tierWrap, credsGrid, backupWarning, actionRow, logPane.el);

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

  // Populates tierWrapper with a radio button per tier create.sh's
  // --list-tiers reports as available in this game's configured region.
  // Preserves the previously-checked tier across a refresh when it's still
  // on offer, so re-checking availability doesn't silently clear the
  // operator's choice.
  async function refreshTiers() {
    if (!state.opsDir || !state.appName) return;
    tiersLoadedForApp = state.appName;
    const previouslyChecked = tierInputs.find((i) => i.checked)?.value;
    refreshTiersButton.disabled = true;
    tierStatus.textContent = "Checking tier availability…";

    let tiers: TierOption[] = [];
    try {
      tiers = (await listAvailableTiers(state.opsDir, state.appName)) ?? [];
    } catch (err) {
      tierWrapper.innerHTML = "";
      tierInputs = [];
      tierStatus.textContent = `Could not check tier availability: ${err instanceof Error ? err.message : String(err)}`;
      refreshTiersButton.disabled = false;
      void render();
      return;
    }

    tierWrapper.innerHTML = "";
    tierInputs = [];
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
    const region = state.deployConf?.dropletRegion?.trim() || "nyc3 (default)";
    tierStatus.textContent =
      tiers.length > 0
        ? ""
        : `No price tiers are available in region ${region}. These droplet sizes aren't sold in every region — set DROPLET_REGION in the Config tab to one that offers them.`;
    refreshTiersButton.disabled = false;
    void render();
  }

  function formFilled(): boolean {
    const tierChosen = tierInputs.some((i) => i.checked);
    return tierChosen && sqlUserInput.value.trim() !== "" && sqlPasswordInput.value.trim() !== "";
  }

  async function render() {
    const deployed = isDeployed();
    const show = Boolean(state.appName) && deployed !== true;
    el.style.display = show ? "" : "none";
    if (!show) return;

    logPane.showGame(state.appName);
    if (state.appName !== tiersLoadedForApp) void refreshTiers();
    const running = isGameRunning("create", state.appName);
    const ready = Boolean(state.deployConfFound && state.opsDir && preflightPassed());
    el.dataset.disabled = ready && !running ? "false" : "true";
    deployButton.disabled = !ready || running || !formFilled();

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
