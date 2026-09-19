import type { Metadata } from "next";
import { Noto_Sans_SC } from "next/font/google";
import "./globals.css";

const notoSansSc = Noto_Sans_SC({
  variable: "--font-noto-sans-sc",
  weight: ["700", "800"],
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "基于三维虚拟仿真与AI图像分析的分光计参数反演实验系统",
  description: "贯穿课前预习、课中测量与课后复盘的分光计实验学习工作台。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={notoSansSc.variable}>{children}</body>
    </html>
  );
}
