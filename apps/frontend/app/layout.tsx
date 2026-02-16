export const metadata = {
  title: 'FM Sync Dashboard',
  description: 'Blackbaud ↔ HubSpot Deal Sync',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
