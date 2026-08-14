import { openOpsDir, checkForUpdate, applyUpdate } from "./api";
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
import { state, subscribe, isDeployed, runningKind } from "./state";

initRunTracking();

const app = document.getElementById("app")!;

const header = document.createElement("header");
header.className = "app-header";
header.innerHTML = "<h1>gameshell-deploy</h1>";

const headerActions = document.createElement("div");
headerActions.className = "header-actions";
const themeSwitcher = createThemeSwitcher();
const openFolderButton = document.createElement("button");
openFolderButton.type = "button";
openFolderButton.className = "secondary";
openFolderButton.textContent = "Open repo folder";
openFolderButton.disabled = true;
openFolderButton.onclick = () => void openOpsDir(state.opsDir);

// See app.go's CheckForUpdate/ApplyUpdate — not yet verified end-to-end
// against a real tagged release, and always reports "up to date" until
// release-go-gui.yml is updated to stamp a version into the build (see
// main.go's appVersion doc comment). Still wired in now so the frontend
// half doesn't have to be revisited once that's fixed.
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
header.appendChild(headerActions);

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
