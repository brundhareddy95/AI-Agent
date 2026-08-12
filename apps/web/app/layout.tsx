import "./globals.css";

export const metadata = {
  title: "AI Agent Workflow Builder",
  description: "Full-stack workflow automation builder"
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}