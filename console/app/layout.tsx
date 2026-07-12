import type { Metadata } from "next";
import "./globals.css";
import { LocaleProvider, LangToggle } from "@/lib/locale";

export const metadata: Metadata = {
  title: "Fluxo — Console",
  description: "Vista sobre el brain: timeline auditable por proyecto.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <LocaleProvider>
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "0.5rem 1rem", borderBottom: "1px solid var(--border)" }}>
            <LangToggle />
          </div>
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
