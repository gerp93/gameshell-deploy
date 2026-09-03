import { createDeployConf, loadDeployConf, saveDeployConf, type DeployConf } from "./api";
import { refreshGames } from "./appPanel";
import { state, notify, isGameRunning } from "./state";

// True while either script is running for the selected game — deploy.conf
// changing mid-run wouldn't affect that run (create.sh/delete.sh already
// have their own copy of the values), but it would be misleading: the
// operator could edit DB_NAME or GIT_REPO believing it applies to the run
// in progress, when it only takes effect on the next one.
function configLocked(): boolean {
  return isGameRunning("create", state.appName) || isGameRunning("delete", state.appName);
}

const emptyConf: DeployConf = {
  appName: "",
  envVarPrefix: "",
  dbName: "",
  httpPort: "",
  gitRepo: "",
  gitUpstream: "",
  gitBranch: "",
  dropletRegion: "",
  dropletImage: "",
  dropletSize: "",
  extraEnvVars: "",
};

const fieldDefs: Array<{ key: keyof DeployConf; label: string; required: boolean }> = [
  { key: "appName", label: "APP_NAME", required: true },
  { key: "envVarPrefix", label: "ENV_VAR_PREFIX", required: true },
  { key: "dbName", label: "DB_NAME", required: true },
  { key: "httpPort", label: "HTTP_PORT", required: true },
  { key: "gitRepo", label: "GIT_REPO (owner/name)", required: true },
  { key: "gitUpstream", label: "GIT_UPSTREAM (optional)", required: false },
  { key: "gitBranch", label: "GIT_BRANCH (blank = repo default)", required: false },
  { key: "dropletRegion", label: "DROPLET_REGION (optional)", required: false },
  { key: "dropletImage", label: "DROPLET_IMAGE (optional)", required: false },
  { key: "dropletSize", label: "DROPLET_SIZE (optional)", required: false },
  { key: "extraEnvVars", label: "EXTRA_ENV_VARS (optional, space-separated names)", required: false },
];

export function createConfigForm(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.innerHTML = `<p class="hint">Stored at games/APP_NAME/deploy.conf. Save it to unlock the Deploy tab.</p>`;

  // Only shown while creating a brand new game (state.deployConfFound ===
  // false) — lets the operator start from an existing game's config instead
  // of typing every field by hand, e.g. for a second instance of the same
  // game (see CLAUDE.md: multiple games/ entries can share GIT_REPO with
  // distinct APP_NAME/DB_NAME). Outside the <form> and explicitly
  // type="button" so it can't be triggered by Enter/submit.
  const cloneWrap = document.createElement("div");
  cloneWrap.className = "field";
  const cloneLabel = document.createElement("label");
  cloneLabel.textContent = "Clone config from";
  const cloneRow = document.createElement("div");
  cloneRow.className = "row";
  const cloneSelect = document.createElement("select");
  const cloneButton = document.createElement("button");
  cloneButton.type = "button";
  cloneButton.className = "secondary";
  cloneButton.textContent = "Clone";
  cloneRow.append(cloneSelect, cloneButton);
  const cloneMessage = document.createElement("div");
  cloneMessage.className = "status-line";
  cloneWrap.append(cloneLabel, cloneRow, cloneMessage);

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
  el.appendChild(cloneWrap);
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

  cloneButton.onclick = async () => {
    const sourceAppName = cloneSelect.value;
    if (!sourceAppName) return;
    cloneMessage.textContent = "";
    cloneButton.disabled = true;
    try {
      const result = await loadDeployConf(state.opsDir, sourceAppName);
      if (!result.found) {
        cloneMessage.textContent = `${sourceAppName} has no deploy.conf to clone from.`;
        return;
      }
      // Keep this game's own APP_NAME (it's tied to the games/ directory
      // already being created) — clone everything else, then let the
      // operator adjust whatever needs to stay unique (DB_NAME especially,
      // since two games sharing one would collide on the same droplet).
      fillForm({ ...result.conf, appName: inputs.appName!.value });
      cloneMessage.textContent = `Cloned from ${sourceAppName} — review DB_NAME and other fields before saving.`;
    } catch (err) {
      cloneMessage.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      cloneButton.disabled = false;
    }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    message.textContent = "";
    // Belt-and-suspenders alongside the dataset.disabled/pointer-events
    // block below: that's a CSS-level block, which stops clicks but not a
    // keyboard Enter-to-submit from a focused field.
    if (configLocked()) {
      message.textContent = "Can't save while a deploy or teardown is running for this game.";
      return;
    }
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
    const locked = configLocked();
    el.dataset.disabled = state.appName && !locked ? "false" : "true";
    saveButton.textContent = locked
      ? "Deploy/teardown running…"
      : state.deployConfFound
        ? "Save deploy.conf"
        : "Create deploy.conf";
    if (!state.loadingGame && state.appName !== formForApp) {
      formForApp = state.appName;
      cloneMessage.textContent = "";
      // A brand new, not-yet-saved game starts blank rather than showing
      // whichever game's config happened to be loaded before it — only
      // APP_NAME is pre-filled, from the games/ directory name being
      // created, since leftover values here (especially GIT_REPO) would be
      // easy to save by mistake without noticing they're stale.
      fillForm(state.deployConf ?? { ...emptyConf, appName: state.appName });
    }

    cloneWrap.style.display = state.deployConfFound ? "none" : "";
    if (!state.deployConfFound) {
      const others = state.games.filter((g) => g !== state.appName);
      const key = others.join(" ");
      // Only rebuild the option list when it's actually stale — this
      // render() can rerun for unrelated reasons (e.g. a background
      // deploy's log line elsewhere calling notify()), and rebuilding on
      // every call would reset the operator's current dropdown selection
      // back to the first option each time.
      if (cloneSelect.dataset.key !== key) {
        cloneSelect.dataset.key = key;
        const previouslySelected = cloneSelect.value;
        cloneSelect.innerHTML = "";
        if (others.length === 0) {
          const opt = document.createElement("option");
          opt.textContent = "No other games to clone from";
          opt.disabled = true;
          cloneSelect.appendChild(opt);
        } else {
          for (const name of others) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            cloneSelect.appendChild(opt);
          }
          if (others.includes(previouslySelected)) cloneSelect.value = previouslySelected;
        }
      }
      cloneButton.disabled = others.length === 0;
    }
  }

  render();
  return { el, render };
}
