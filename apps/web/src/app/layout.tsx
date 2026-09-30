import type { Metadata } from "next";
import { Atkinson_Hyperlegible_Next, Big_Shoulders } from "next/font/google";

import "./globals.css";

const display = Big_Shoulders({
  variable: "--font-display-loaded",
  subsets: ["latin"],
});

const body = Atkinson_Hyperlegible_Next({
  variable: "--font-body-loaded",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Quillwheel Cycle Works | Voice Agent Sandbox",
  description:
    "A fictional bicycle workshop used to demonstrate a voice agent: services, opening hours, and open appointment times.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
