export interface TabDef {
  id: string;
  label: () => string;
  el: HTMLElement;
  // Omit for "always visible". When it returns false, the tab's button and
  // content are both hidden — e.g. Deploy/Teardown before deploy.conf exists
  // yet, there's nothing sensible to deploy or tear down.
  visible?: () => boolean;
}

// A minimal tab bar + content switcher — labels are functions since e.g. the
// second tab's label changes between "Deploy" and "Teardown" depending on
// app state, not just which tab is active.
export function createTabs(
  tabs: TabDef[],
  getActive: () => string,
  setActive: (id: string) => void,
): { el: HTMLElement; render: () => void } {
  const el = document.createElement("div");
  el.className = "tabs-wrapper";

  const bar = document.createElement("div");
  bar.className = "tab-bar";
  const content = document.createElement("div");
  content.className = "tab-content";

  const buttons = new Map<string, HTMLButtonElement>();
  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-button";
    btn.onclick = () => {
      setActive(tab.id);
      render();
    };
    buttons.set(tab.id, btn);
    bar.appendChild(btn);
    content.appendChild(tab.el);
  }

  el.append(bar, content);

  function render() {
    let active = getActive();
    const isVisible = (tab: TabDef) => tab.visible?.() ?? true;

    // If the active tab just became hidden (e.g. deploy.conf was cleared),
    // fall back to the first still-visible tab rather than showing nothing.
    const activeTab = tabs.find((t) => t.id === active);
    if (activeTab && !isVisible(activeTab)) {
      const fallback = tabs.find(isVisible);
      if (fallback) {
        active = fallback.id;
        setActive(active);
      }
    }

    for (const tab of tabs) {
      const btn = buttons.get(tab.id)!;
      const visible = isVisible(tab);
      btn.style.display = visible ? "" : "none";
      btn.textContent = tab.label();
      btn.classList.toggle("active", tab.id === active);
      tab.el.style.display = visible && tab.id === active ? "" : "none";
    }
  }

  render();
  return { el, render };
}
