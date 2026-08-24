"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const listeners = new Set<() => void>();

function storedTheme(): Theme {
  try {
    const value = window.localStorage.getItem("theme");
    return value === "light" || value === "dark" || value === "system"
      ? value
      : "system";
  } catch {
    return "system";
  }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? systemTheme() : theme;
}

function applyTheme(theme: Theme): ResolvedTheme {
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

let snapshot: ThemeContextValue = {
  theme: "system",
  resolvedTheme: "light",
  setTheme,
};

if (typeof window !== "undefined") {
  const theme = storedTheme();
  snapshot = { theme, resolvedTheme: applyTheme(theme), setTheme };
}

function emit(theme: Theme) {
  snapshot = { theme, resolvedTheme: applyTheme(theme), setTheme };
  for (const listener of listeners) listener();
}

function setTheme(theme: Theme) {
  try {
    window.localStorage.setItem("theme", theme);
  } catch {
    // The theme still applies for this session when storage is unavailable.
  }
  emit(theme);
}

let mediaQuery: MediaQueryList | null = null;
function onMediaChange() {
  if (snapshot.theme === "system") emit("system");
}
function onStorage(event: StorageEvent) {
  if (event.key === "theme") emit(storedTheme());
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    applyTheme(snapshot.theme);
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", onMediaChange);
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && mediaQuery !== null) {
      mediaQuery.removeEventListener("change", onMediaChange);
      window.removeEventListener("storage", onStorage);
      mediaQuery = null;
    }
  };
}

function getSnapshot() {
  return snapshot;
}

const serverSnapshot: ThemeContextValue = {
  theme: "system",
  resolvedTheme: "light",
  setTheme,
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const value = useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme must be used inside ThemeProvider.");
  }
  return value;
}
