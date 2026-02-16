// src/utils/theme.ts

type Theme = "light" | "dark";

let currentTheme: Theme;

function updateBodyClass(win: Window, theme: Theme) {
  const body = win.document.body;
  if (body) {
    body.classList.remove("light", "dark");
    body.classList.add(theme);
  }
}

export function initThemeObserver(win: _ZoteroTypes.MainWindow) {
  const docElement = win.document.documentElement;
  if (!docElement) {
    return () => {};
  }

  const observer = new win.MutationObserver((mutations: MutationRecord[]) => {
    for (const mutation of mutations) {
      if (
        mutation.type === "attributes" &&
        mutation.attributeName === "theme"
      ) {
        const newTheme = docElement.getAttribute("theme") as Theme;
        if (newTheme && newTheme !== currentTheme) {
          currentTheme = newTheme;
          updateBodyClass(win, newTheme);
          // You might want to dispatch a custom event here
          // to notify other parts of your plugin about the theme change.
        }
      }
    }
  });

  observer.observe(docElement, { attributes: true });

  // Set initial theme
  currentTheme = (docElement.getAttribute("theme") as Theme) || "light";
  updateBodyClass(win, currentTheme);

  // Return a function to disconnect the observer when the window is unloaded
  return () => {
    observer.disconnect();
  };
}

export function getTheme(): Theme {
  return currentTheme;
}
