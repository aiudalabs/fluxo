"use client";

// F6-04 · Runtime locale for the console — a small context so the language toggle flips
// every client surface at once (i18n completo, no rebuild). Persists the choice in
// localStorage; defaults to DEFAULT_LOCALE (español-first). No dependency.

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { DEFAULT_LOCALE, LOCALES, t as translate, type Locale } from "./i18n-flat";

const STORAGE_KEY = "fluxo.lang";

type LocaleCtx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const Ctx = createContext<LocaleCtx | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "es" || saved === "en") setLocaleState(saved);
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    window.localStorage.setItem(STORAGE_KEY, l);
  }, []);

  const t = useCallback((key: string, vars?: Record<string, string | number>) => translate(locale, key, vars), [locale]);

  return <Ctx.Provider value={{ locale, setLocale, t }}>{children}</Ctx.Provider>;
}

export function useLocale(): LocaleCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLocale must be used within a LocaleProvider");
  return ctx;
}

export function LangToggle() {
  const { locale, setLocale } = useLocale();
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {LOCALES.map((l) => (
        <button
          key={l}
          onClick={() => setLocale(l)}
          aria-pressed={locale === l}
          style={{
            cursor: "pointer", fontSize: 12, textTransform: "uppercase", borderRadius: 6, padding: "2px 8px",
            border: `1px solid ${locale === l ? "var(--accent)" : "var(--border)"}`,
            background: locale === l ? "var(--accent)" : "transparent",
            color: locale === l ? "#0d1117" : "var(--muted)",
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
