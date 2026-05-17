import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Red Spectrum Customer Intelligence",
  description: "Internal dashboard for customer scoring and export",
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
