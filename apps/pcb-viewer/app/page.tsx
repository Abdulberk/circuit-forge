'use client';
import dynamic from 'next/dynamic';

// r3f must run client-side only (no SSR) — load the Canvas dynamically.
const Viewer = dynamic(() => import('../components/Viewer'), {
  ssr: false,
  loading: () => (
    <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', color: '#cfe0d6', font: '14px ui-monospace, monospace' }}>
      3D yükleniyor…
    </div>
  ),
});

export default function Page() {
  return <Viewer />;
}
