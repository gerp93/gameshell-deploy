import { currentCodeCheck, dismissCodeUpdate, isCodeUpdateDismissed } from "./codeCheck";
import { state, notify, runningKind } from "./state";

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// "17 new commits", "1 new commit", or "new commits" when they couldn't be counted.
export function commitsText(commits: number): string {
  if (commits < 0) return "new commits";
  return `${commits} new commit${commits === 1 ? "" : "s"}`;
}

// The proactive "there's new code to redeploy" notice, shown above the tabs so
// it's seen on any tab. Informational only: it never redeploys by itself, and
// redeploying doesn't depend on it. The button just takes the operator to the
// Redeploy panel, where the details (and any destructive SQL) are shown.
export function createCodeBanner(): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.className = "code-banner";
  el.style.display = "none";

  const text = document.createElement("div");
  text.className = "code-banner-text";
  const headline = document.createElement("strong");
  const detail = document.createElement("span");
  text.append(headline, detail);

  const actions = document.createElement("div");
  actions.className = "row";
  const reviewButton = document.createElement("button");
  reviewButton.type = "button";
  reviewButton.textContent = "Review & redeploy";
  reviewButton.onclick = () => {
    state.activeTab = "action";
    state.manageMode = "redeploy";
    notify();
  };
  const dismissButton = document.createElement("button");
  dismissButton.type = "button";
  dismissButton.className = "secondary";
  dismissButton.textContent = "Dismiss";
  dismissButton.title = "Hide this until there's an even newer commit";
  dismissButton.onclick = () => {
    const result = currentCodeCheck();
    if (result) dismissCodeUpdate(state.appName, result.latest);
  };
  actions.append(reviewButton, dismissButton);

  el.append(text, actions);

  function render() {
    const result = currentCodeCheck();
    const show =
      Boolean(state.appName) &&
      !state.loadingGame &&
      result?.state === "behind" &&
      !runningKind(state.appName) &&
      !isCodeUpdateDismissed(state.appName, result.latest);
    el.style.display = show ? "" : "none";
    if (!show || !result) return;

    headline.textContent = `New code available on ${result.branch}:`;
    const bits = [`${commitsText(result.commits)} (${shortSha(result.deployed)} → ${shortSha(result.latest)}) not deployed yet.`];
    if (result.destructiveSql.length > 0) {
      bits.push("Includes SQL that removes or rewrites data — review before redeploying.");
    }
    detail.textContent = " " + bits.join(" ");
  }

  render();
  return { el, render };
}
