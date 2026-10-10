import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";
import Providers from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PrePaid — Good things, on repeat",
  description: "Plan recurring USDC payments on Arc. Set your recipient, amount, and schedule with PrePaid.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased motion-reduce:[&_*]:transition-none! motion-reduce:[&_*]:scroll-auto!`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans text-[14px]"><Providers>{children}</Providers></body>
    </html>
  );
}
