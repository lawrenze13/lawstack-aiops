import type { Metadata } from "next";
import { Suspense } from "react";
import { JetBrains_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { ToastHost } from "@/components/toast/ToastHost";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { NavigationProgress } from "@/components/nav/NavigationProgress";

// "Signal room" typography per the heroui-migration plan:
//   - Body = JetBrains Mono (dense, monospace-forward operator console feel)
//   - Display = IBM Plex Sans (headers / button labels / modal titles)
// Explicitly NOT Inter, which is the generic AI-tool default.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "LawStack/aiops",
  description: "Operator console for Claude Code — ticket to PR, in lanes.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // `suppressHydrationWarning` is required because next-themes writes
    // `html.dark` client-side before React hydrates — without this, React 19
    // would log a hydration mismatch on every cold load.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${jetbrainsMono.variable} ${ibmPlexSans.variable}`}
    >
      <body>
        <ThemeProvider>
          <Suspense fallback={null}>
            <NavigationProgress />
          </Suspense>
          <ToastHost>{children}</ToastHost>
        </ThemeProvider>
      </body>
    </html>
  );
}
