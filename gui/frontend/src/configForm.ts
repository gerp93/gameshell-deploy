import { createDeployConf, saveDeployConf, type DeployConf } from "./api";
import { refreshGames } from "./appPanel";
import { state, notify } from "./state";

const emptyConf: DeployConf = {
  appName: "",
  envVarPrefix: "",
  dbName: "",
  httpPort: "",
  gitRepo: "",
  gitUpstream: "",
  dropletRegion: "",
  dropletImage: "",
  dropletSize: "",
};

const fieldDefs: Array<{ key: keyof DeployConf; label: string; required: boolean }> = [
  { key: "appName", label: "APP_NAME", required: true },
  { key: "envVarPrefix", label: "ENV_VAR_PREFIX", required: true },
  { key: "dbName", label: "DB_NAME", required: true },
  { key: "httpPort", label: "HTTP_PORT", required: true },
  { key: "gitRepo", label: "GIT_REPO (owner/name)", required: true },
  { key: "gitUpstream", label: "GIT_UPSTREAM (optional)", required: false },
  { key: "dropletRegion", label: "DROPLET_REGION (optional)", required: false },
  { key: "dropletImage", label: "DROPLET_IMAGE (optional)", required: false },
  { key: "dropletSize", label: "DROPLET_SIZE (optional)", required: false },
];

export function createConfigForm(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.innerHTML = `<p class="hint">Stored at games/APP_NAME/deploy.conf. Save it to unlock the Deploy tab.</p>`;

  const form = document.createElement("form");
  const grid = document.createElement("div");
  grid.className = "field-grid";
  form.appendChild(grid);
  const inputs: Partial<Record<keyof DeployConf, HTMLInputElement>> = {};

  for (const def of fieldDefs) {
    const wrapper = document.createElement("div");
    wrapper.className = "field";
    const label = document.createElement("label");
    label.textContent = def.label;
    const input = document.createElement("input");
    input.required = def.required;
    wrapper.appendChild(label);
    wrapper.appendChild(input);
    grid.appendChild(wrapper);
    inputs[def.key] = input;
  }

  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  form.appendChild(saveButton);

  const message = document.createElement("div");
  message.className = "status-line";
  el.appendChild(form);
  el.appendChild(message);

  function currentConf(): DeployConf {
    const conf = { ...emptyConf };
    for (const def of fieldDefs) {
      conf[def.key] = inputs[def.key]!.value;
    }
    return conf;
  }

  function fillForm(conf: DeployConf) {
    for (const def of fieldDefs) {
      inputs[def.key]!.value = conf[def.key] ?? "";
    }
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    message.textContent = "";
    try {
      const conf = currentConf();
      if (state.deployConfFound) {
        await saveDeployConf(state.opsDir, state.appName, conf);
      } else {
        await createDeployConf(state.opsDir, state.appName, conf);
        state.deployConfFound = true;
        // The games/appName directory (and this game's entry in the
        // sidebar) didn't exist until createDeployConf just made it.
        await refreshGames();
      }
      state.deployConf = conf;
      message.textContent = "Saved.";
      notify();
    } catch (err) {
      message.textContent = `Error: ${String(err)}`;
    }
  };

  // Tracks which game the form fields currently reflect, so switching games
  // repopulates them (or clears them, for a brand new game) exactly once —
  // re-running fillForm() on every render would also wipe out whatever the
  // operator is mid-typing in an unsaved form. Gated on !state.loadingGame
  // too: chooseApp() sets state.appName and notifies immediately, before
  // its async loadDeployConf() call resolves, so a naive appName-only guard
  // fills the form from a still-null state.deployConf and then never
  // refills once the real one arrives (formForApp already "matches" by
  // then).
  let formForApp: string | null = null;

  function render() {
    el.dataset.disabled = state.appName ? "false" : "true";
    saveButton.textContent = state.deployConfFound ? "Save deploy.conf" : "Create deploy.conf";
    if (!state.loadingGame && state.appName !== formForApp) {
      formForApp = state.appName;
      // A brand new, not-yet-saved game starts blank rather than showing
      // whichever game's config happened to be loaded before it — only
      // APP_NAME is pre-filled, from the games/ directory name being
      // created, since leftover values here (especially GIT_REPO) would be
      // easy to save by mistake without noticing they're stale.
      fillForm(state.deployConf ?? { ...emptyConf, appName: state.appName });
    }
  }

  render();
  return { el, render };
}
