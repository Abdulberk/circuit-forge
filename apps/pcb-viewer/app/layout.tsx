import type { ReactNode } from 'react';

export const metadata = {
    title: 'circuit-forge · PCB 3D viewer',
    description: 'Photorealistic Three.js/WebGL viewer for pipeline-produced PCBs',
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="tr">
            <body style={{ margin: 0, height: '100vh', background: '#080d10' }}>{children}</body>
        </html>
    );
}
