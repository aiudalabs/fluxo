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
        {/* Anti-flash · Mission Control es dark-first: aplica dark salvo que el usuario haya elegido light. */}
        <script dangerouslySetInnerHTML={{ __html: `try{if(localStorage.getItem('fluxo_theme')!=='light')document.documentElement.setAttribute('data-theme','dark')}catch(e){document.documentElement.setAttribute('data-theme','dark')}` }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Mission Control: Space Grotesk (display) · Inter (UI) · JetBrains Mono (data). */}
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap"
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
