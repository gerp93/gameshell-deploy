import { runPreflightChecks } from "./api";
import { state, notify } from "./state";

export function createPreflightPanel(): HTMLElement {
  const section = document.createElement("section");
  section.innerHTML = "<h2>Prerequisites</h2>";
  const list = document.createElement("div");
  section.appendChild(list);

  const refreshButton = document.createElement("button");
  refreshButton.textContent = "Re-check";
  refreshButton.onclick = () => void refresh();
  section.appendChild(refreshButton);

  async function refresh() {
    const result = await runPreflightChecks();
    state.preflight = result;
    list.innerHTML = "";

    if (result.wslBlocking) {
      const row = document.createElement("div");
      row.className = "check-row";
      row.innerHTML = `<span class="fail">✗</span> <strong>WSL is required on Windows and was not found.</strong>`;
      list.appendChild(row);
      const detail = document.createElement("div");
      detail.textContent = result.checks[0]?.detail ?? "";
      list.appendChild(detail);
      notify();
      return;
    }

    for (const check of result.checks) {
      const row = document.createElement("div");
      row.className = "check-row";
      row.innerHTML = `<span class="${check.ok ? "ok" : "fail"}">${check.ok ? "✓" : "✗"}</span> <strong>${check.name}</strong> — ${check.detail}`;
      list.appendChild(row);
    }
    notify();
  }

  void refresh();
  return section;
}
