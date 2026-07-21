import { createPreflightPanel } from "./preflightPanel";
import { createOpsRepoPanel } from "./opsRepoPanel";
import { createGameRepoPanel } from "./gameRepoPanel";
import { createConfigForm } from "./configForm";
import { createDeployPanel } from "./deployPanel";
import { createTeardownPanel } from "./teardownPanel";
import { subscribe } from "./state";

const app = document.getElementById("app")!;

const preflight = createPreflightPanel();
const opsRepo = createOpsRepoPanel();
const gameRepo = createGameRepoPanel();
const configForm = createConfigForm();
const deploy = createDeployPanel();
const teardown = createTeardownPanel();

app.append(preflight, opsRepo.el, gameRepo.el, configForm.el, deploy.el, teardown.el);

subscribe(() => {
  opsRepo.render();
  gameRepo.render();
  configForm.render();
  deploy.render();
  teardown.render();
});
