import { state, notify, manageMode, manageSwitchAvailable } from "./state";

// The Redeploy / Teardown choice at the top of a deployed game's Manage tab.
// The two forms ask for different things (and one of them deletes everything),
// so only the selected one is shown rather than stacking them.
export function createManageSwitch(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.className = "mode-switch";
  el.setAttribute("role", "radiogroup");
  el.setAttribute("aria-label", "What to do with this deployment");

  const inputs = new Map<"redeploy" | "teardown", HTMLInputElement>();
  function option(value: "redeploy" | "teardown", text: string) {
    const label = document.createElement("label");
    label.className = "mode-switch-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "manage-mode";
    input.value = value;
    input.onchange = () => {
      if (!input.checked) return;
      state.manageMode = value;
      notify();
    };
    inputs.set(value, input);
    label.append(input, ` ${text}`);
    return label;
  }
  el.append(option("redeploy", "Redeploy new code"), option("teardown", "Teardown"));

  function render() {
    el.style.display = manageSwitchAvailable() ? "" : "none";
    const mode = manageMode();
    for (const [value, input] of inputs) input.checked = value === mode;
  }

  render();
  return { el, render };
}
