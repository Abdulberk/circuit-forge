'use client';

import type { ReactNode } from 'react';

import { useSession } from '../../app/providers';
import { Button } from '../ui/Button';
import { ThemeToggle } from '../ui/ThemeToggle';

import { Brand } from './Brand';

/**
 * The top bar every signed-in screen shares: brand, a slot for the screen's own controls (breadcrumb,
 * tabs), and the account controls. One component, so the bar does not drift between screens.
 */
export function AppHeader({ children }: { children?: ReactNode }) {
    const { client } = useSession();
    return (
        <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-surface px-4">
            <Brand />
            <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
            <ThemeToggle />
            <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                    void client.signOut();
                }}
            >
                Sign out
            </Button>
        </header>
    );
}
