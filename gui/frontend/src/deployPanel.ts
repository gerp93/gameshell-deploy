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
  checkExtraSecret,
  configuredSecretChecks,
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
import { createSecretField, type SecretField } from "./secretField";

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
  const sshKeyHint = document.createElement("div");
  sshKeyHint.className = "hint";
  sshKeyWrap.append(sshKeyLabel, sshKeyRow, sshKeyHint);
  let keysLoadedForOpsDir = "";

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

  const sqlUserField = createSecretField("DEPLOY_SQL_USER", "text", () => void render());
  const sqlPasswordField = createSecretField("DEPLOY_SQL_PASSWORD", "password", () => void render());
  const gpgPassphraseField = createSecretField(
    "GPG_PASSPHRASE (only if restoring a backup)",
    "password",
    () => void render(),
  );

  // Extra secrets named in deploy.conf EXTRA_ENV_VARS — names are not
  // secret and come from config; values are typed here at deploy time.
  // With "Remember on this computer" they live in the OS keyring, not
  // deploy.conf / settings.json.
  const extraEnvWrap = document.createElement("div");
  extraEnvWrap.className = "field-grid";
  extraEnvWrap.style.display = "none";
  const extraEnvFields = new Map<string, SecretField>();

  // One button tests every extra key at once, using whatever value is in each
  // field right now (so the environment-vs-keychain choice made above is what
  // gets tested). Each key shows Pass / Failed / Skipped beside its field —
  // Skipped when no key check is enabled for it in the Config tab.
  const testAllRow = document.createElement("div");
  testAllRow.className = "test-all-row";
  const testAllButton = document.createElement("button");
  testAllButton.type = "button";
  testAllButton.className = "secondary";
  testAllButton.textContent = "Test all keys";
  // Testing keys needs no DigitalOcean access, so this stays clickable even
  // while the rest of the panel is dimmed by a failing prerequisite check.
  testAllButton.style.pointerEvents = "auto";
  const testAllSummary = document.createElement("span");
  testAllSummary.className = "secret-check-result";
  testAllRow.append(testAllButton, testAllSummary);

  function clearTestSummary() {
    testAllSummary.textContent = "";
    testAllSummary.className = "secret-check-result";
  }

  testAllButton.onclick = async () => {
    testAllButton.disabled = true;
    testAllSummary.className = "secret-check-result";
    testAllSummary.textContent = "Testing…";
    const entries = [...extraEnvFields];
    const results = await Promise.all(entries.map(([, field]) => field.runCheck()));

    let pass = 0;
    let failed = 0;
    let unverified = 0;
    let skipped = 0;
    for (const [i, [, field]] of entries.entries()) {
      const result = results[i];
      if (result === null) {
        skipped++;
        field.showSkipped(field.hasChecker() ? "the field is empty." : "no key check is enabled for it in the Config tab.");
      } else if (result.status === "ok") {
        pass++;
      } else if (result.status === "invalid") {
        failed++;
      } else {
        unverified++;
      }
    }

    const parts = [`${pass} pass`, `${failed} failed`];
    if (unverified > 0) parts.push(`${unverified} couldn't verify`);
    parts.push(`${skipped} skipped`);
    testAllSummary.textContent = parts.join(" · ");
    testAllSummary.className = `secret-check-result ${failed > 0 ? "fail" : pass > 0 && unverified === 0 ? "ok" : ""}`.trim();
    testAllButton.disabled = false;
  };

  let extraEnvFor = "";
  // What the fields' "Test key" buttons were last attached for. Checks are
  // editable in the Config tab, so saving there must update these without
  // rebuilding the fields (which would wipe a key the operator just typed).
  let extraEnvChecksFor = "";

  function extraEnvNames(): string[] {
    return resolveExtraEnvNames(
      state.deployConf?.extraEnvVars ?? "",
      state.deployConf?.envVarPrefix ?? "",
    );
  }

  function rebuildExtraEnvFields() {
    const names = extraEnvNames();
    const key = `${state.appName}\0${names.join(" ")}`;
    const checksKey = JSON.stringify(state.deployConf?.secretChecks ?? []);
    if (key === extraEnvFor) {
      if (checksKey !== extraEnvChecksFor) {
        extraEnvChecksFor = checksKey;
        void attachChecks(key, names);
      }
      return;
    }
    extraEnvFor = key;
    extraEnvChecksFor = checksKey;
    extraEnvWrap.innerHTML = "";
    extraEnvFields.clear();
    extraEnvWrap.style.display = names.length ? "" : "none";
    clearTestSummary();
    extraEnvWrap.appendChild(testAllRow);
    for (const name of names) {
      // Editing a key (or switching its source) makes the last summary stale.
      const field = createSecretField(
        name,
        "password",
        () => {
          clearTestSummary();
          void render();
        },
        clearTestSummary,
      );
      extraEnvWrap.appendChild(field.wrap);
      extraEnvFields.set(name, field);
    }
    void fillSecrets();
    void attachChecks(key, names);
  }

  // Offers "Test key" only for secrets whose deploy.conf has a SECRET_CHECK_*
  // line. forKey stamps the lookup with the field set it was started for, so
  // a slow answer can't attach buttons to another game's fields after a switch.
  async function attachChecks(forKey: string, names: string[]) {
    const { opsDir, appName } = state;
    if (!opsDir || !appName || names.length === 0) return;
    try {
      const configured = new Set((await configuredSecretChecks(opsDir, appName, names)) ?? []);
      if (extraEnvFor !== forKey) return;
      for (const [name, field] of extraEnvFields) {
        // No per-field button: "Test all keys" above the fields runs them all.
        field.setChecker(configured.has(name) ? (value) => checkExtraSecret(opsDir, appName, name, value) : null, false);
      }
    } catch (err) {
      // Untested keys are still deployable, but say so — silently showing no
      // buttons is indistinguishable from "no checks configured".
      if (extraEnvFor === forKey) {
        checkStatus.textContent = `Couldn't load key checks: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  // Fingerprints of key values the operator was told were rejected and chose
  // to deploy with anyway (by clicking Deploy a second time). Hashed rather
  // than stored so a rejected key doesn't linger in memory beside its field.
  const acknowledgedBadKeys = new Set<string>();

  async function fingerprint(name: string, value: string): Promise<string> {
    const data = new TextEncoder().encode(`${name}\0${value}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  const checkStatus = document.createElement("div");
  checkStatus.className = "status-line";

  // Tests every extra key that has a configured check, before anything is
  // saved or created. Only a key the service actively rejects stops the
  // deploy, and only once: the operator can click Deploy again to override
  // (the check itself could be misconfigured). "Couldn't verify" never blocks.
  async function keysOkToDeploy(): Promise<boolean> {
    checkStatus.textContent = "";
    const entries = [...extraEnvFields];
    if (entries.length === 0) return true;
    deployButton.disabled = true;
    const results = await Promise.all(entries.map(([, field]) => field.runCheck()));

    const rejected: [string, string][] = [];
    const unverified: string[] = [];
    for (const [i, [name, field]] of entries.entries()) {
      const status = results[i]?.status;
      if (status === "unverified") unverified.push(name);
      if (status !== "invalid") continue;
      const print = await fingerprint(name, field.input.value);
      if (!acknowledgedBadKeys.has(print)) rejected.push([name, print]);
    }

    if (rejected.length > 0) {
      for (const [, print] of rejected) acknowledgedBadKeys.add(print);
      const many = rejected.length > 1;
      checkStatus.textContent = `Deploy not started — ${rejected.map(([n]) => n).join(", ")} ${many ? "were" : "was"} rejected (see above). Fix the key${many ? "s" : ""}, or click Deploy again to deploy anyway.`;
      void render();
      return false;
    }
    acknowledgedBadKeys.clear();
    if (unverified.length > 0) {
      checkStatus.textContent = `Couldn't verify ${unverified.join(", ")} (see above) — deploying anyway.`;
    }
    return true;
  }

  async function fillSecrets() {
    try {
      const { env, keyring } = await loadSecrets(extraEnvNames());
      sqlUserField.applyLoaded(env.sqlUser ?? "", keyring.sqlUser ?? "");
      sqlPasswordField.applyLoaded(env.sqlPassword ?? "", keyring.sqlPassword ?? "");
      gpgPassphraseField.applyLoaded(env.gpgPassphrase ?? "", keyring.gpgPassphrase ?? "");
      const envByKey = new Map((env.extraEnv ?? []).map((ev) => [ev.key, ev.value]));
      const keyringByKey = new Map((keyring.extraEnv ?? []).map((ev) => [ev.key, ev.value]));
      for (const [name, field] of extraEnvFields) {
        field.applyLoaded(envByKey.get(name) ?? "", keyringByKey.get(name) ?? "");
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
    "Empty fields are filled from your environment (DEPLOY_SQL_USER, extra API keys, GPG_PASSPHRASE) if set — including WSL on Windows — or from the OS keychain if you've saved one here before; if both have a value and they differ, pick which one to use. Check the box to save what you type or pick here, in the OS keychain, not in the repo or deploy.conf.";
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
    sqlUserField.refreshTypedHint(rememberCheck.checked);
    sqlPasswordField.refreshTypedHint(rememberCheck.checked);
    gpgPassphraseField.refreshTypedHint(rememberCheck.checked);
    for (const field of extraEnvFields.values()) field.refreshTypedHint(rememberCheck.checked);
  };
  forgetButton.onclick = async () => {
    rememberStatus.textContent = "";
    try {
      await forgetSecrets(extraEnvNames());
      sqlUserField.reset();
      sqlPasswordField.reset();
      gpgPassphraseField.reset();
      for (const field of extraEnvFields.values()) field.reset();
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
    const sqlUser = sqlUserField.input.value;
    const sqlPassword = sqlPasswordField.input.value;
    const gpgPassphrase = gpgPassphraseField.input.value;
    const extraEnv: ExtraEnvVar[] = [];
    for (const [name, field] of extraEnvFields) {
      extraEnv.push({ key: name, value: field.input.value });
    }

    if (!(await keysOkToDeploy())) return;

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
      sqlUserField.reset();
      sqlPasswordField.reset();
      gpgPassphraseField.reset();
      for (const field of extraEnvFields.values()) field.reset();
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
  credsGrid.append(sqlUserField.wrap, sqlPasswordField.wrap, gpgPassphraseField.wrap);

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
  const formParts = [sshKeyWrap, regionWrap, tierWrap, credsGrid, extraEnvWrap, rememberWrap, backupWarning, checkStatus, actionRow];

  el.append(
    sshKeyWrap,
    regionWrap,
    tierWrap,
    credsGrid,
    extraEnvWrap,
    rememberWrap,
    backupWarning,
    checkStatus,
    actionRow,
    startNewRow,
    runSummary.el,
    logPane.el,
  );

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
          : "None of this account's SSH keys are on this computer. Add this PC's public key to DigitalOcean, or copy the matching private key into ~/.ssh.";
    } catch (err) {
      sshKeyHint.textContent = `Could not list SSH keys: ${err instanceof Error ? err.message : String(err)}`;
    }
    void render();
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
    if (
      !tierChosen ||
      !sshKeySelect.value ||
      sqlUserField.input.value.trim() === "" ||
      sqlPasswordField.input.value.trim() === ""
    ) {
      return false;
    }
    for (const field of extraEnvFields.values()) {
      if (field.input.value.trim() === "") return false;
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
    if (!hideForm && state.opsDir && keysLoadedForOpsDir !== state.opsDir) {
      keysLoadedForOpsDir = state.opsDir;
      void refreshKeys();
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

  void render();
  return { el, render: () => void render() };
}
