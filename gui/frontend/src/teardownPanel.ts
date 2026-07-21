import { runDelete } from "./api";
import { createLogPane } from "./logPane";
import { state, preflightPassed } from "./state";

export function createTeardownPanel(): { el: HTMLElement; render: () => void } {
  const section = document.createElement("section");
  section.innerHTML = "<h2>Teardown</h2>";

  const backupYes = document.createElement("input");
  backupYes.type = "radio";
  backupYes.name = "backup";
  backupYes.value = "yes";
  backupYes.checked = true;
  const backupNo = document.createElement("input");
  backupNo.type = "radio";
  backupNo.name = "backup";
  backupNo.value = "no";

  const teardownButton = document.createElement("button");
  teardownButton.textContent = "Teardown";

  const { el: logEl, clear: clearLog } = createLogPane("delete:log", "delete:exit", () => {
    state.running = false;
    teardownButton.disabled = false;
  });

  teardownButton.onclick = async () => {
    if (!state.gameRepoDir || !state.opsDir) return;
    const backup = backupYes.checked ? "yes" : "no";

    clearLog();
    state.running = true;
    teardownButton.disabled = true;

    await runDelete({
      opsDir: state.opsDir,
      gameRepoDir: state.gameRepoDir,
      backup,
    });
  };

  const backupLabelYes = document.createElement("label");
  backupLabelYes.append(backupYes, " Back up database first");
  const backupLabelNo = document.createElement("label");
  backupLabelNo.append(backupNo, " Skip backup");

  section.append(backupLabelYes, document.createElement("br"), backupLabelNo, teardownButton, logEl);

  function render() {
    const ready = Boolean(state.gameRepoDir && state.opsDir && preflightPassed());
    section.dataset.disabled = ready && !state.running ? "false" : "true";
  }

  render();
  return { el: section, render };
}
