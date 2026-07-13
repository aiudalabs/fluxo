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
        <link rel="preconnect" href="https://api.fontshare.com" crossOrigin="" />
        <link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap" rel="stylesheet" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap"
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
