import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SonarTrace — Hear Your Code Run",
  description:
    "Real-time execution telemetry sonified into a spatial audio landscape for accessible debugging.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}