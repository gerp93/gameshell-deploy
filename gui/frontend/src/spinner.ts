// A small inline loading indicator — used wherever an action can take a
// couple of seconds (e.g. switching games re-reads deploy.conf and re-checks
// DO status) so the UI doesn't just sit static with no feedback.
export function createSpinner(label: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "spinner-row";
  el.innerHTML = `<span class="spinner"></span> ${label}`;
  return el;
}
