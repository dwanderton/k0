import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// the pitch, verbatim from the root README
const description =
  'k0 listens to your side of a live customer call and surfaces the right knowledge-base passage as you speak. Restate the customer\'s question aloud and the answer lands on screen, highlighted and sourced, before you say "let me check."';

export const metadata: Metadata = {
  metadataBase: new URL("https://k0-omega.vercel.app"),
  title: "k0",
  description,
  openGraph: {
    title: "k0 — knowledge that follows your voice",
    description,
    url: "/",
    siteName: "k0",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "k0 — knowledge that follows your voice",
    description,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
