"use client";

import { useState } from "react";
import { toggleTheme, currentTheme } from "@/lib/theme";

export function ThemeToggle({ className = "sh-theme" }: { className?: string }) {
  const [, force] = useState(0);
  return (
    <button className={className} type="button" aria-label="Tema claro / oscuro" title="Tema claro / oscuro" onClick={() => { toggleTheme(); force((n) => n + 1); }}>
      {currentTheme() === "dark" ? "☀" : "☾"}
    </button>
  );
}
