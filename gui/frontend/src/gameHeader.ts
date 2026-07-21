import { state } from "./state";

// The selected game's name + deployed/not-deployed pill, shown above the
// Config/Deploy tabs.
export function createGameHeader(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.className = "game-header";

  function render() {
    if (!state.appName) {
      el.innerHTML = `<p class="hint">Select a game from the sidebar, or add a new one.</p>`;
      return;
    }
    const deployed = state.status ? state.status.dropletExists || state.status.appExists : null;
    const pill =
      deployed === null
        ? ""
        : deployed
          ? '<span class="pill pill-deployed">Deployed</span>'
          : '<span class="pill pill-not-deployed">Not deployed</span>';
    el.innerHTML = `<h2>${state.appName}</h2>${pill}`;
  }

  render();
  return { el, render };
}
