import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SPECTRA｜AI 分光计实验学习助手",
  description: "贯穿课前预习、课中测量与课后复盘的分光计实验学习工作台。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
