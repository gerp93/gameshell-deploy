import { loadSettings, loadDeployConf, selectGameRepoDir } from "./api";
import { state, notify } from "./state";

export function createGameRepoPanel(): { el: HTMLElement; render: () => void } {
  const section = document.createElement("section");
  section.innerHTML = "<h2>Game repo checkout</h2>";

  const status = document.createElement("div");
  section.appendChild(status);

  const button = document.createElement("button");
  button.textContent = "Choose folder…";
  button.onclick = async () => {
    const dir = await selectGameRepoDir();
    if (dir) {
      state.gameRepoDir = dir;
      await refreshDeployConf();
      notify();
    }
  };
  section.appendChild(button);

  async function refreshDeployConf() {
    if (!state.gameRepoDir) return;
    const result = await loadDeployConf(state.gameRepoDir);
    state.deployConfFound = result.found;
    state.deployConf = result.found ? result.conf : null;
    render();
  }

  function render() {
    if (!state.gameRepoDir) {
      status.textContent = "Not selected yet.";
      return;
    }
    status.textContent = `Using: ${state.gameRepoDir} — deploy.conf ${state.deployConfFound ? "found" : "not found"}`;
  }

  void loadSettings().then(async (s) => {
    if (s.lastGameRepoDir) {
      state.gameRepoDir = s.lastGameRepoDir;
      await refreshDeployConf();
      notify();
    }
  });

  render();
  return { el: section, render };
}
