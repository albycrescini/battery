import "./globals.css";

export const metadata = {
  title: "Music Backup",
  description: "Personal music library backups and favorite lifecycle history.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
