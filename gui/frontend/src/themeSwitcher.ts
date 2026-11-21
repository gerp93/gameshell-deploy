import { loadSettings, setTheme } from "./api";

// Slugs must match the `data-theme` values defined in themes.css.
const THEMES: Array<{ slug: string; label: string }> = [
  { slug: "", label: "Default (system)" },
  { slug: "blue-oval", label: "Blue Oval" },
  { slug: "bubblegum", label: "Bubblegum" },
  { slug: "commander-keen", label: "Commander Keen" },
  { slug: "electric-lime", label: "Electric Lime" },
  { slug: "flambeau", label: "Flambeau" },
  { slug: "flambeau-inverse", label: "Flambeau Inverse" },
  { slug: "green-acres", label: "Green Acres" },
  { slug: "hacker", label: "Hacker" },
  { slug: "hawkeye", label: "Hawkeye" },
  { slug: "lava", label: "Lava" },
  { slug: "merica", label: "Merica" },
  { slug: "neon", label: "Neon" },
  { slug: "red-barn", label: "Red Barn" },
  { slug: "retrowave", label: "Retrowave" },
];

function applyTheme(slug: string): void {
  if (slug) {
    document.documentElement.dataset.theme = slug;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

// A plain <select> in the header — deliberately not a custom dropdown
// widget, so it inherits native OS styling/keyboard behavior for free and
// stays consistent with every other <select> in the app (see style.css's
// shared `select` rule).
export function createThemeSwitcher(): HTMLElement {
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Theme");
  for (const theme of THEMES) {
    const opt = document.createElement("option");
    opt.value = theme.slug;
    opt.textContent = theme.label;
    select.appendChild(opt);
  }

  select.onchange = () => {
    applyTheme(select.value);
    void setTheme(select.value);
  };

  void loadSettings().then((s) => {
    select.value = s.theme;
    applyTheme(s.theme);
  });

  return select;
}
