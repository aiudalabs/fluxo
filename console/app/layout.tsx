import type { Metadata } from "next";
import "./globals.css";
import { LocaleProvider } from "@/lib/locale";
import { I18nProvider } from "@/lib/i18n";
import { AuthCapture } from "@/components/AuthCapture";

export const metadata: Metadata = {
  title: "Fluxo — by AIuda Labs",
  description: "UI de la fábrica de software gobernada — AIuda Labs.",
};

// Fuentes del design system de v1: Satoshi (Fontshare), Instrument Serif + JetBrains Mono (Google).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        {/* Anti-flash · Mission Control dark-first: pone SIEMPRE el atributo explícito (light si el
            usuario lo eligió, dark si no) antes del primer paint — así el toggle nunca queda ambiguo. */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('fluxo_theme');document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark')}catch(e){document.documentElement.setAttribute('data-theme','dark')}` }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* MD3 type roles: Space Grotesk (display/headline/title) · Inter (body/label) ·
            JetBrains Mono (data). Inter 700 incluido: el CSS usa 700 real, nunca pesos sintetizados. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <I18nProvider>
          <LocaleProvider>
            <AuthCapture />
            {children}
          </LocaleProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
