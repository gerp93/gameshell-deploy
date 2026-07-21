import { loadSettings, selectOpsDir } from "./api";
import { state, notify } from "./state";

export function createOpsRepoPanel(): { el: HTMLElement; render: () => void } {
  const section = document.createElement("section");
  section.innerHTML = "<h2>gameshell-deploy checkout</h2>";

  const status = document.createElement("div");
  section.appendChild(status);

  const button = document.createElement("button");
  button.textContent = "Choose folder…";
  button.onclick = async () => {
    const dir = await selectOpsDir();
    if (dir) {
      state.opsDir = dir;
      render();
      notify();
    }
  };
  section.appendChild(button);

  function render() {
    status.textContent = state.opsDir ? `Using: ${state.opsDir}` : "Not selected yet.";
  }

  void loadSettings().then((s) => {
    if (s.opsDir) {
      state.opsDir = s.opsDir;
      render();
      notify();
    }
  });

  render();
  return { el: section, render };
}
