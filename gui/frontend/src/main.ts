import { openOpsDir, checkForUpdate, applyUpdate, getVersion } from "./api";
import { createPreflightPanel } from "./preflightPanel";
import { createAppPanel } from "./appPanel";
import { createGameHeader } from "./gameHeader";
import { createConfigForm } from "./configForm";
import { createDeployPanel } from "./deployPanel";
import { createTeardownPanel } from "./teardownPanel";
import { createRedeployPanel } from "./redeployPanel";
import { createCodeBanner } from "./codeBanner";
import { createManageSwitch } from "./manageSwitch";
import { startCodeCheckPolling } from "./codeCheck";
import { createTabs } from "./tabs";
import { createThemeSwitcher } from "./themeSwitcher";
import { createSpinner } from "./spinner";
import { createSpendBadge } from "./spendBadge";
import { initRunTracking } from "./runTracking";
import { state, subscribe, isDeployed, runningKind, hasFailedExit } from "./state";

initRunTracking();
startCodeCheckPolling();

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
openFolderButton.textContent = "Open data folder";
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

// Which build this is, beside the update check so "am I on the latest?" is
// answerable at a glance. A local build (never stamped by the release
// workflow) reports "0.0.0-dev"; shown as "dev build" rather than a version
// that looks real.
const versionLabel = document.createElement("span");
versionLabel.className = "app-version";
versionLabel.title = "Installed version";
void getVersion()
  .then((version) => {
    versionLabel.textContent = version.endsWith("-dev") ? "dev build" : version.startsWith("v") ? version : `v${version}`;
  })
  .catch(() => {
    // Purely informational; an unreadable version just leaves the label blank.
  });

headerActions.append(createSpendBadge(), themeSwitcher, openFolderButton, versionLabel, updateButton);
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
const redeploy = createRedeployPanel();
const codeBanner = createCodeBanner();
const manageSwitch = createManageSwitch();

// A deployed game picks Redeploy or Teardown with the switch on top; only the
// chosen form is shown, so the two sets of fields are never conflated.
const actionTabContent = document.createElement("div");
actionTabContent.append(manageSwitch.el, deploy.el, redeploy.el, teardown.el);

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
        if (kind === "redeploy") return "Redeploying…";
        // Failed create with leftover resources: stay on Deploy so the log
        // is what you see, not an empty Teardown form.
        if (hasFailedExit("create", state.appName)) return "Deploy";
        // A deployed game offers both Redeploy and Teardown on this tab.
        return isDeployed() === true ? "Manage" : "Deploy";
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
main.append(gameHeader.el, codeBanner.el, loadingSpinner, tabs.el);
layout.append(sidebar.el, main);
app.append(header, preflight.el, layout);

subscribe(() => {
  openFolderButton.disabled = !state.opsDir;
  loadingSpinner.style.display = state.loadingGame ? "flex" : "none";
  tabs.el.style.display = state.appName && !state.loadingGame ? "" : "none";
  sidebar.render();
  gameHeader.render();
  codeBanner.render();
  tabs.render();
  configForm.render();
  // deploy/teardown each re-point their log pane at state.appName on every
  // render (see logPane.showGame) — a game deploying in the background
  // keeps streaming into its own history even while another game is shown.
  manageSwitch.render();
  deploy.render();
  redeploy.render();
  teardown.render();
});
