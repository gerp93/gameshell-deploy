import { createDeployConf, saveDeployConf, type DeployConf } from "./api";
import { state, notify } from "./state";

const emptyConf: DeployConf = {
  appName: "",
  envPrefix: "",
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
  { key: "envPrefix", label: "ENV_PREFIX", required: true },
  { key: "dbName", label: "DB_NAME", required: true },
  { key: "httpPort", label: "HTTP_PORT", required: true },
  { key: "gitRepo", label: "GIT_REPO (owner/name)", required: true },
  { key: "gitUpstream", label: "GIT_UPSTREAM (optional)", required: false },
  { key: "dropletRegion", label: "DROPLET_REGION (optional)", required: false },
  { key: "dropletImage", label: "DROPLET_IMAGE (optional)", required: false },
  { key: "dropletSize", label: "DROPLET_SIZE (optional)", required: false },
];

export function createConfigForm(): { el: HTMLElement; render: () => void } {
  const section = document.createElement("section");
  section.innerHTML = "<h2>deploy.conf</h2>";

  const form = document.createElement("form");
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
    form.appendChild(wrapper);
    inputs[def.key] = input;
  }

  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  form.appendChild(saveButton);

  const message = document.createElement("div");
  section.appendChild(form);
  section.appendChild(message);

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
        await saveDeployConf(state.gameRepoDir, conf);
      } else {
        await createDeployConf(state.opsDir, state.gameRepoDir, conf);
        state.deployConfFound = true;
      }
      state.deployConf = conf;
      message.textContent = "Saved.";
      notify();
    } catch (err) {
      message.textContent = `Error: ${String(err)}`;
    }
  };

  function render() {
    section.dataset.disabled = state.gameRepoDir ? "false" : "true";
    saveButton.textContent = state.deployConfFound ? "Save deploy.conf" : "Create deploy.conf";
    if (state.deployConf) fillForm(state.deployConf);
  }

  render();
  return { el: section, render };
}
