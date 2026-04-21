import type { Metadata } from "next";
import "./globals.css";
import { ToastHost } from "@/components/toast/ToastHost";

export const metadata: Metadata = {
  title: "multiportal-ai-ops",
  description: "AI ticket-automation swimlanes",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <ToastHost>{children}</ToastHost>
      </body>
    </html>
  );
}
