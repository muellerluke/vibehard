import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>vibehard next-express example</header>
        {children}
      </body>
    </html>
  );
}
