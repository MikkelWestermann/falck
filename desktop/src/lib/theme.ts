import { useEffect, useState } from "react";

const STORAGE_KEY = "falck-theme";

export type Theme = "light" | "dark";

function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return null;
}

function getEffectiveTheme(): Theme {
  return getStoredTheme() ?? "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => getEffectiveTheme());

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);


  const setTheme = (next: Theme) => setThemeState(next);
  const toggleTheme = () =>
    setThemeState((prev) => (prev === "dark" ? "light" : "dark"));

  return { theme, setTheme, toggleTheme };
}
