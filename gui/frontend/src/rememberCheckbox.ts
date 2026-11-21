import { loadSettings, setRememberSecrets } from "./api";

// "Remember secrets on this computer" for the Redeploy and Teardown forms.
// It is the same app-wide setting as the Deploy tab's checkbox (the Go side
// stores one rememberSecrets flag), but a deployed game never shows the Deploy
// tab, so without this the box was unreachable exactly when the GPG passphrase
// is typed — Redeploy and Teardown honored the setting without offering it.
//
// The setting is re-read when the selected game changes (via sync()), so a
// change made on the Deploy tab is picked up without a call on every render.
export function createRememberCheckbox(onChange: (remember: boolean) => void): {
  el: HTMLElement;
  sync: (appName: string) => void;
} {
  const el = document.createElement("div");
  el.className = "field";

  const label = document.createElement("label");
  label.className = "extra-env-check";
  const check = document.createElement("input");
  check.type = "checkbox";
  label.append(check, document.createTextNode(" Remember GPG_PASSPHRASE on this computer"));

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "Saves the passphrase in the OS keychain (not in the repo or deploy.conf) when you start the run, and pre-fills it next time. Same setting as \"Remember secrets\" on the Deploy tab.";

  const status = document.createElement("div");
  status.className = "status-line";

  el.append(label, hint, status);

  check.onchange = () => {
    status.textContent = "";
    void setRememberSecrets(check.checked).catch((err) => {
      status.textContent = `Couldn't save preference: ${err instanceof Error ? err.message : String(err)}`;
    });
    onChange(check.checked);
  };

  let syncedFor: string | null = null;
  // Callers invoke this from render(), which runs constantly; the settings
  // file is only read when the selected game changes.
  function sync(appName: string) {
    if (syncedFor === appName) return;
    syncedFor = appName;
    void loadSettings()
      .then((s) => {
        check.checked = Boolean(s.rememberSecrets);
        onChange(check.checked);
      })
      .catch(() => {
        // Leave the box as it is; toggling it still saves.
      });
  }

  return { el, sync };
}
