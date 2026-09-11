// Shared by deployPanel.ts and teardownPanel.ts: a small hint line under a
// pre-fillable secret field saying whether its value came from a real
// environment variable or a keyring entry saved via "Remember secrets on
// this computer" — see SecretsBundle's *Source fields in api.ts.

export function createSourceLabel(): HTMLElement {
  const el = document.createElement("p");
  el.className = "hint source-label";
  return el;
}

export function setSourceLabel(el: HTMLElement, source: "env" | "keyring" | undefined): void {
  switch (source) {
    case "env":
      el.textContent = "Pre-filled from an environment variable on this computer.";
      break;
    case "keyring":
      el.textContent = "Pre-filled from the OS keychain (saved via \"Remember secrets\").";
      break;
    default:
      el.textContent = "";
  }
}
