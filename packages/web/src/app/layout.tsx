import type { Metadata } from "next";
import { Google_Sans_Flex } from "next/font/google";
import { GeistMono } from "geist/font/mono";
import { SiteHeader } from "../components/site-header";
import "./globals.css";

const googleSans = Google_Sans_Flex({ subsets: ["latin"], variable: "--font-ui", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Twin — review what a coding command changed", template: "%s · Twin" },
  description: "Run coding commands in a complete project copy, inspect a receipt, then apply or discard. Explore Twin's committed fixed-action comparison.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${googleSans.variable} ${GeistMono.variable}`}>
      <body><a className="skip-link" href="#main-content">skip to content</a><SiteHeader />{children}</body>
    </html>
  );
}
