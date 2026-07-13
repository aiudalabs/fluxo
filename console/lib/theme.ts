// F6P-07 · Tema light/dark. Fluxo default LIGHT (su identidad); el toggle opta a dark y se
// persiste. El data-theme lo aplica un script anti-flash en el <head> (layout) antes del
// primer paint; este helper solo lo togglea en runtime.

export type Theme = "light" | "dark";
const KEY = "fluxo_theme";

export function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return (document.documentElement.getAttribute("data-theme") as Theme) || "light";
}

export function setTheme(t: Theme) {
  if (typeof document === "undefined") return;
  if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}
