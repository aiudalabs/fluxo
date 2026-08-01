"use client";

// Selector de idioma (i18n, v1.2). Dropdown compacto con banderas — va en la esquina
// superior derecha (topbar) y en las pantallas de auth. Persistido por el
// I18nProvider (localStorage). 🇪🇸 ES · 🇬🇧 EN · 🇧🇷 PT.
//
// Patrón accesible: una etiqueta visible (bandera + código) con un <select> nativo
// transparente encima que captura el clic y abre el menú del SO con las tres banderas.

import { LANGS, useI18n, type Lang } from "@/lib/i18n";

const FLAG: Record<Lang, string> = { es: "🇪🇸", en: "🇬🇧", pt: "🇧🇷" };

export function LanguageSwitcher() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="langsw" title={t("lang.label")}>
      <span className="face" aria-hidden>
        <span className="flag">{FLAG[lang]}</span>
        <span className="code">{lang.toUpperCase()}</span>
        <span className="caret">▾</span>
      </span>
      <select
        aria-label={t("lang.label")}
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
      >
        {LANGS.map((l) => (
          <option key={l} value={l}>
            {FLAG[l]} {t(`lang.${l}`)}
          </option>
        ))}
      </select>
      <style jsx>{`
        .langsw {
          position: relative;
          display: inline-flex;
          align-items: center;
          height: var(--ctl-h);
          flex: none;
        }
        .face {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: var(--ctl-h);
          padding: 0 14px;
          border: 1px solid var(--md-outline);
          border-radius: var(--shape-full);
          background: transparent;
          transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
        }
        .langsw:hover .face {
          background: var(--state-hover);
          border-color: var(--md-primary);
        }
        .flag {
          font-size: 15px;
          line-height: 1;
        }
        .code {
          font: var(--type-label);
          letter-spacing: 0.03em;
          color: var(--md-on-surface);
        }
        .caret {
          font-size: 10px;
          color: var(--md-on-surface-variant);
        }
        select {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          opacity: 0;
          cursor: pointer;
          border: none;
        }
      `}</style>
    </div>
  );
}
