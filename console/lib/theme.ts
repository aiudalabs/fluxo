// Tema light/dark. Mission Control es DARK-first (su identidad); el toggle opta a light y se
// persiste. El data-theme lo aplica un script anti-flash en el <head> (layout) antes del
// primer paint (dark salvo elección 'light'); este helper solo lo togglea en runtime.

export type Theme = "light" | "dark";
const KEY = "fluxo_theme";

export function currentTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return (document.documentElement.getAttribute("data-theme") as Theme) || "dark";
}

export function setTheme(t: Theme) {
  if (typeof document === "undefined") return;
  // SIEMPRE explícito (light o dark) — el CSS define :root[data-theme="light"] y "dark". Removerlo
  // dejaba el estado light sin atributo y currentTheme() (default dark) no lo detectaba → toggle trabado.
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}
