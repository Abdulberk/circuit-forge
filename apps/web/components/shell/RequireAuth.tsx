'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useSession } from '../../app/providers';

/**
 * Renders its children only for a signed-in browser; otherwise sends the user to /login and brings them
 * back afterwards (`?next=`). The check runs on the client because the token lives in this browser — a
 * Server Component cannot see it, which is why the app is client-first.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
    const { signedIn } = useSession();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (signedIn === false) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }, [signedIn, router, pathname]);

    // Null means "not asked yet": rendering anything would flash the wrong screen.
    if (signedIn !== true) return <FullPageSpinner />;
    return <>{children}</>;
}

export function FullPageSpinner({ label = 'Loading…' }: { label?: string }) {
    return (
        <div className="grid h-screen place-items-center bg-bg" role="status" aria-live="polite">
            <div className="flex items-center gap-3 text-sm text-muted">
                <span className="size-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
                {label}
            </div>
        </div>
    );
}
