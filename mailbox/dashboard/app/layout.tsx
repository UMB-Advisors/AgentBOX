import type { Metadata } from 'next';
import './globals.css';

// Font variables (--font-sans/mono/serif) are defined as system stacks in
// globals.css. The appliance builds offline so we don't pull from Google
// Fonts at build time.

export const metadata: Metadata = {
  title: 'MailBox One',
  description: 'Approval queue for LLM-generated email drafts',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
