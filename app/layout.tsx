import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Verificación de identidad | Onboarding Atlántida",
  description: "Experiencia de verificación de identidad para Banco Atlántida.",
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es-HN"><body>{children}</body></html>;
}
