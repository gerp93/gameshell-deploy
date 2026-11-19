import { openURL, runFunnel } from "./api";
import { refreshStatus } from "./appPanel";
import { state, notify, runningKind } from "./state";

// Internet access for a game running on the home server: Tailscale Funnel on or
// off. A new game is private; this is the only place the GUI makes one public,
// and turning it on always asks first. Only shown for a deployed home-server
// game with nothing running for it.
export function createFunnelPanel(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.className = "funnel-panel";

  const title = document.createElement("h3");
  title.textContent = "Internet access (Tailscale Funnel)";

  const statusLine = document.createElement("div");
  statusLine.className = "status-line";

  const urlLine = document.createElement("div");
  urlLine.className = "game-header-url";

  const hint = document.createElement("p");
  hint.className = "hint";

  const onButton = document.createElement("button");
  onButton.type = "button";
  onButton.textContent = "Turn on Funnel…";
  const offButton = document.createElement("button");
  offButton.type = "button";
  offButton.className = "secondary";
  offButton.textContent = "Turn off Funnel";
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "secondary";
  openButton.textContent = "Open public link ↗";
  const buttons = document.createElement("div");
  buttons.className = "row";
  buttons.append(onButton, offButton, openButton);

  // Inline confirmation rather than a popup, so the warning is always visible.
  const confirmBox = document.createElement("div");
  confirmBox.className = "status-line";
  confirmBox.style.display = "none";
  const confirmText = document.createElement("p");
  const confirmRow = document.createElement("div");
  confirmRow.className = "row";
  const confirmYes = document.createElement("button");
  confirmYes.type = "button";
  confirmYes.textContent = "Yes, publish it";
  const confirmNo = document.createElement("button");
  confirmNo.type = "button";
  confirmNo.className = "secondary";
  confirmNo.textContent = "Cancel";
  confirmRow.append(confirmYes, confirmNo);
  confirmBox.append(confirmText, confirmRow);

  const output = document.createElement("pre");
  output.className = "funnel-output";
  output.style.display = "none";

  el.append(title, statusLine, urlLine, hint, buttons, confirmBox, output);

  let busy = false;
  let confirmFor = "";

  function funnelPort(): string {
    return (state.deployConf?.holocronFunnelPort ?? "").trim();
  }

  async function act(action: "on" | "off") {
    const game = state.appName;
    busy = true;
    confirmFor = "";
    output.style.display = "";
    output.textContent = action === "on" ? "Turning Funnel on…" : "Turning Funnel off…";
    render();
    try {
      const text = await runFunnel(state.opsDir, game, action);
      output.textContent = text || "Done.";
    } catch (err) {
      output.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      busy = false;
      if (state.appName === game) {
        try {
          await refreshStatus();
        } catch {
          // The output above says what happened; the status line just stays as it was.
        }
      }
      notify();
    }
  }

  onButton.onclick = () => {
    confirmFor = state.appName;
    render();
  };
  confirmNo.onclick = () => {
    confirmFor = "";
    render();
  };
  confirmYes.onclick = () => void act("on");
  offButton.onclick = () => void act("off");
  openButton.onclick = () => {
    const url = state.status?.appURL;
    if (url) void openURL(url);
  };

  function render() {
    const status = state.status;
    const show =
      Boolean(state.appName) &&
      !state.loadingGame &&
      status?.holocron === true &&
      status.appExists &&
      runningKind(state.appName) === null;
    el.style.display = show ? "" : "none";
    if (!show || !status) return;

    if (confirmFor && confirmFor !== state.appName) confirmFor = "";
    const port = funnelPort();
    const on = status.funnelOn;
    statusLine.textContent = on
      ? "Funnel is ON — anyone with the link can reach this game from the internet."
      : "Funnel is off — this game is not reachable from the internet.";
    urlLine.textContent = on ? status.appURL : "";
    urlLine.style.display = on ? "" : "none";
    hint.textContent = port
      ? `Uses Funnel port ${port}. Before the first time, two switches in the Tailscale admin console must be on: DNS › HTTPS Certificates, and Funnel allowed for this machine in Access controls.`
      : "Set HOLOCRON_FUNNEL_PORT (443, 8443 or 10000) in the Config tab to use Funnel for this game.";

    confirmText.textContent = `This makes ${state.appName} reachable by anyone on the internet who has the link (Tailscale Funnel, port ${port}). Its own login is the only protection. Continue?`;
    confirmBox.style.display = confirmFor === state.appName && !busy ? "" : "none";

    onButton.style.display = on ? "none" : "";
    offButton.style.display = on ? "" : "none";
    openButton.style.display = on && status.appURL ? "" : "none";
    onButton.disabled = busy || !port || confirmFor === state.appName;
    offButton.disabled = busy;
  }

  render();
  return { el, render };
}
