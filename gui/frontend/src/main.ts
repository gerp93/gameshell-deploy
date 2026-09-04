import { openOpsDir, checkForUpdate, applyUpdate, getAppVersion } from "./api";
import { createPreflightPanel } from "./preflightPanel";
import { createAppPanel } from "./appPanel";
import { createGameHeader } from "./gameHeader";
import { createConfigForm } from "./configForm";
import { createDeployPanel } from "./deployPanel";
import { createTeardownPanel } from "./teardownPanel";
import { createTabs } from "./tabs";
import { createThemeSwitcher } from "./themeSwitcher";
import { createSpinner } from "./spinner";
import { initRunTracking } from "./runTracking";
import { state, subscribe, isDeployed, runningKind, hasFailedExit } from "./state";

initRunTracking();

const app = document.getElementById("app")!;

const header = document.createElement("header");
header.className = "app-header";
const titleWrap = document.createElement("div");
titleWrap.className = "header-title";
const title = document.createElement("h1");
title.textContent = "gameshell-deploy";
const versionEl = document.createElement("span");
versionEl.className = "app-version";
titleWrap.append(title, versionEl);
void getAppVersion().then((v) => {
  if (v) versionEl.textContent = v;
});

const headerActions = document.createElement("div");
headerActions.className = "header-actions";
const themeSwitcher = createThemeSwitcher();
const openFolderButton = document.createElement("button");
openFolderButton.type = "button";
openFolderButton.className = "secondary";
openFolderButton.textContent = "Open data folder";
openFolderButton.disabled = true;
openFolderButton.onclick = () => void openOpsDir(state.opsDir);

const updateButton = document.createElement("button");
updateButton.type = "button";
updateButton.className = "secondary";
updateButton.textContent = "Check for Updates";
updateButton.onclick = () => {
  void (async () => {
    updateButton.disabled = true;
    const previousLabel = updateButton.textContent;
    try {
      const result = await checkForUpdate();
      if (!result.available) {
        updateButton.textContent = "Up to date";
        setTimeout(() => (updateButton.textContent = previousLabel), 2000);
        return;
      }
      if (confirm(`Version ${result.version} is available. Download and install it now?`)) {
        updateButton.textContent = "Updating…";
        await applyUpdate();
      }
    } catch (err) {
      alert(`Update check failed: ${err}`);
      updateButton.textContent = previousLabel;
    } finally {
      updateButton.disabled = false;
    }
  })();
};

headerActions.append(themeSwitcher, openFolderButton, updateButton);
header.append(titleWrap, headerActions);

const preflight = createPreflightPanel();

const layout = document.createElement("div");
layout.className = "app-layout";

const sidebar = createAppPanel();

const main = document.createElement("main");
main.className = "main-content";

const gameHeader = createGameHeader();
const configForm = createConfigForm();
const deploy = createDeployPanel();
const teardown = createTeardownPanel();

const actionTabContent = document.createElement("div");
actionTabContent.append(deploy.el, teardown.el);

const tabs = createTabs(
  [
    {
      id: "action",
      // While a script is running the label names what's happening, so the
      // in-progress state is visible without opening the tab.
      label: () => {
        const kind = runningKind(state.appName);
        if (kind === "create") return "Deploying…";
        if (kind === "delete") return "Tearing down…";
        // Failed create with leftover resources: stay on Deploy so the log
        // is what you see, not an empty Teardown form.
        if (hasFailedExit("create", state.appName)) return "Deploy";
        return isDeployed() === true ? "Teardown" : "Deploy";
      },
      el: actionTabContent,
      visible: () => state.deployConfFound,
    },
    { id: "config", label: () => "Config", el: configForm.el },
  ],
  () => state.activeTab,
  (id) => {
    state.activeTab = id as "config" | "action";
  },
);

const loadingSpinner = createSpinner("Loading game…");
loadingSpinner.style.display = "none";

tabs.el.style.display = "none";
main.append(gameHeader.el, loadingSpinner, tabs.el);
layout.append(sidebar.el, main);
app.append(header, preflight.el, layout);

subscribe(() => {
  openFolderButton.disabled = !state.opsDir;
  loadingSpinner.style.display = state.loadingGame ? "flex" : "none";
  tabs.el.style.display = state.appName && !state.loadingGame ? "" : "none";
  sidebar.render();
  gameHeader.render();
  tabs.render();
  configForm.render();
  // deploy/teardown each re-point their log pane at state.appName on every
  // render (see logPane.showGame) — a game deploying in the background
  // keeps streaming into its own history even while another game is shown.
  deploy.render();
  teardown.render();
});
