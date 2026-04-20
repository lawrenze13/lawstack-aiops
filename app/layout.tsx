import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "multiportal-ai-ops",
  description: "AI ticket-automation swimlanes",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
