// Light/dark theme shared by the side panel and the chat window.
const UI_THEME_KEY = "uiTheme";

function applyUiTheme(theme) {
  const dark = theme === "dark";
  document.body.classList.toggle("theme-dark", dark);
  const btn = document.getElementById("themeToggleBtn");
  if (btn) {
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }
}

function initUiTheme() {
  try {
    chrome.storage.local.get([UI_THEME_KEY], (res) => applyUiTheme(res && res[UI_THEME_KEY]));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[UI_THEME_KEY]) applyUiTheme(changes[UI_THEME_KEY].newValue);
    });
  } catch (err) {
    // preview pages without chrome.storage stay light
  }

  const btn = document.getElementById("themeToggleBtn");
  if (btn) {
    btn.addEventListener("click", () => {
      const next = document.body.classList.contains("theme-dark") ? "light" : "dark";
      applyUiTheme(next);
      chrome.storage.local.set({ [UI_THEME_KEY]: next });
    });
  }
}

initUiTheme();
