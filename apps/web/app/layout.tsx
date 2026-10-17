import type { Metadata } from 'next';

import { THEME_BOOT_SCRIPT } from '../components/ui/theme-boot';

import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
    title: { default: 'Circuit Forge', template: '%s · Circuit Forge' },
    description: 'Design, simulate and lay out circuits.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        // `data-theme` is set before paint by the boot script; the server cannot know it, so React is told
        // the attribute on <html> may differ between server and client.
        <html lang="en" suppressHydrationWarning>
            <head>
                <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
            </head>
            <body>
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
