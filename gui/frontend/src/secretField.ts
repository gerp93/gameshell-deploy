// A pre-fillable secret input (DB user/password, GPG passphrase, extra API
// keys) shared by deployPanel.ts and teardownPanel.ts. Wraps the plumbing
// each of these fields needs:
//   - pre-fill from an environment variable and/or a keyring entry
//   - when both exist and disagree, a radio choice instead of silently
//     preferring one (an environment variable can easily be stale)
//   - a hint line saying where the current value came from, or that the
//     operator typed it themselves and it's about to be saved

let nextRadioGroupID = 0;

export interface SecretField {
  wrap: HTMLElement;
  input: HTMLInputElement;
  // Pre-fills from envValue/keyringValue unless the operator has already
  // typed something in (never clobbers a manual edit). Safe to call again
  // (e.g. after switching games) — re-evaluates from scratch.
  applyLoaded(envValue: string, keyringValue: string): void;
  // Clears the field back to its pre-load state (used by "Forget saved
  // secrets" and after a run that didn't opt into "Remember").
  reset(): void;
  // Re-renders the "Typed here…" hint to reflect the current "Remember
  // secrets" checkbox state — call when that checkbox changes, for any
  // field the operator has already typed into.
  refreshTypedHint(remember: boolean): void;
}

export function createSecretField(
  labelText: string,
  type: "text" | "password",
  onInput: () => void,
  // Fired whenever the field's value is set from a source (initial
  // pre-fill or a radio switch) — never from manual typing. Only
  // teardownPanel.ts needs this, to keep its separate "confirm passphrase"
  // field in sync with a source-selected value without also auto-filling
  // it while the operator is typing (which would defeat its purpose as a
  // typo check).
  onSourceSelect?: () => void,
): SecretField {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  if (type === "password") input.type = "password";

  const radioGroup = document.createElement("div");
  radioGroup.className = "source-radio-group";
  radioGroup.hidden = true;
  const radioName = `secret-source-${nextRadioGroupID++}`;

  const envOption = document.createElement("label");
  envOption.className = "source-radio-option";
  const envRadio = document.createElement("input");
  envRadio.type = "radio";
  envRadio.name = radioName;
  envRadio.value = "env";
  envOption.append(envRadio, document.createTextNode(" Environment variable"));

  const keyringOption = document.createElement("label");
  keyringOption.className = "source-radio-option";
  const keyringRadio = document.createElement("input");
  keyringRadio.type = "radio";
  keyringRadio.name = radioName;
  keyringRadio.value = "keyring";
  keyringOption.append(keyringRadio, document.createTextNode(" OS keychain"));

  radioGroup.append(envOption, keyringOption);

  const hint = document.createElement("p");
  hint.className = "hint source-label";

  let lastEnvValue = "";
  let lastKeyringValue = "";
  let manuallyTyped = false;

  function selectSource(source: "env" | "keyring") {
    input.value = source === "env" ? lastEnvValue : lastKeyringValue;
    hint.textContent =
      source === "env"
        ? "Pre-filled from an environment variable on this computer."
        : "Pre-filled from the OS keychain (saved via \"Remember secrets\").";
  }

  envRadio.onchange = () => {
    if (envRadio.checked) {
      selectSource("env");
      onSourceSelect?.();
    }
  };
  keyringRadio.onchange = () => {
    if (keyringRadio.checked) {
      selectSource("keyring");
      onSourceSelect?.();
    }
  };

  input.oninput = () => {
    manuallyTyped = true;
    radioGroup.hidden = true;
    hint.textContent = input.value
      ? 'Typed here — will be saved to the OS keychain if "Remember secrets" is checked.'
      : "";
    onInput();
  };

  function applyLoaded(envValue: string, keyringValue: string) {
    lastEnvValue = envValue;
    lastKeyringValue = keyringValue;
    if (input.value || manuallyTyped) return;
    if (envValue && keyringValue && envValue !== keyringValue) {
      radioGroup.hidden = false;
      envRadio.checked = true;
      keyringRadio.checked = false;
      selectSource("env");
      onSourceSelect?.();
    } else if (envValue || keyringValue) {
      radioGroup.hidden = true;
      selectSource(envValue ? "env" : "keyring");
      onSourceSelect?.();
    }
  }

  function reset() {
    input.value = "";
    lastEnvValue = "";
    lastKeyringValue = "";
    manuallyTyped = false;
    radioGroup.hidden = true;
    hint.textContent = "";
  }

  function refreshTypedHint(remember: boolean) {
    if (!manuallyTyped) return;
    hint.textContent = input.value
      ? remember
        ? 'Typed here — will be saved to the OS keychain if "Remember secrets" is checked.'
        : 'Typed here — check "Remember secrets on this computer" to save this for next time.'
      : "";
  }

  wrap.append(label, input, radioGroup, hint);
  return { wrap, input, applyLoaded, reset, refreshTypedHint };
}
