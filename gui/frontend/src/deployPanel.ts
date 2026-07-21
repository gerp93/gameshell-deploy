import { hasBackups, listSSHKeys, runCreate } from "./api";
import { createLogPane } from "./logPane";
import { state, preflightPassed } from "./state";

const TIERS: Array<{ value: string; label: string }> = [
  { value: "1", label: "1) $17/month, $0.02518/hour" },
  { value: "2", label: "2) $48/month, $0.07155/hour" },
  { value: "3", label: "3) $96/month, $0.14273/hour" },
];

export function createDeployPanel(): { el: HTMLElement; render: () => void } {
  const section = document.createElement("section");
  section.innerHTML = "<h2>Deploy</h2>";

  const sshKeySelect = document.createElement("select");
  const refreshKeysButton = document.createElement("button");
  refreshKeysButton.type = "button";
  refreshKeysButton.textContent = "Refresh SSH keys";
  refreshKeysButton.onclick = () => void refreshKeys();

  const tierWrapper = document.createElement("div");
  const tierInputs: HTMLInputElement[] = [];
  for (const tier of TIERS) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "tier";
    input.value = tier.value;
    tierInputs.push(input);
    label.appendChild(input);
    label.append(" " + tier.label);
    tierWrapper.appendChild(label);
    tierWrapper.appendChild(document.createElement("br"));
  }

  const sqlUserInput = document.createElement("input");
  sqlUserInput.placeholder = "DEPLOY_SQL_USER";
  const sqlPasswordInput = document.createElement("input");
  sqlPasswordInput.type = "password";
  sqlPasswordInput.placeholder = "DEPLOY_SQL_PASSWORD";

  const backupWarning = document.createElement("div");

  const deployButton = document.createElement("button");
  deployButton.textContent = "Deploy";

  const { el: logEl, clear: clearLog } = createLogPane("create:log", "create:exit", (info) => {
    state.running = false;
    deployButton.disabled = false;
    // Secrets are cleared immediately once a run starts (see below); this
    // just re-enables the form for another attempt.
  });

  deployButton.onclick = async () => {
    if (!state.gameRepoDir || !state.opsDir) return;
    const tier = tierInputs.find((i) => i.checked)?.value ?? "";
    const sshKeyName = sshKeySelect.value;
    const sqlUser = sqlUserInput.value;
    const sqlPassword = sqlPasswordInput.value;

    clearLog();
    state.running = true;
    deployButton.disabled = true;

    // Clear secret fields from memory immediately once the run has been
    // handed off — they're never persisted to disk.
    sqlUserInput.value = "";
    sqlPasswordInput.value = "";

    await runCreate({
      opsDir: state.opsDir,
      gameRepoDir: state.gameRepoDir,
      sshKeyName,
      tier,
      autoYes: true,
      sqlUser,
      sqlPassword,
    });
  };

  section.append(
    "SSH key: ",
    sshKeySelect,
    refreshKeysButton,
    document.createElement("br"),
    tierWrapper,
    sqlUserInput,
    sqlPasswordInput,
    backupWarning,
    deployButton,
    logEl,
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

  async function render() {
    const ready = Boolean(state.gameRepoDir && state.deployConfFound && state.opsDir && preflightPassed());
    section.dataset.disabled = ready && !state.running ? "false" : "true";
    if (state.gameRepoDir) {
      const ok = await hasBackups(state.gameRepoDir);
      backupWarning.textContent = ok ? "" : "No backups/*.gpg found in the game repo — deploy will fail without one.";
    }
  }

  void refreshKeys();
  void render();
  return { el: section, render: () => void render() };
}
