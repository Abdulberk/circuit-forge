'use client';

import { useEffect, useState } from 'react';

import { Button } from './Button';
import { THEME_KEY as KEY } from './theme-boot';

export type Theme = 'light' | 'dark';

export function ThemeToggle() {
    // Null until mounted: the server cannot know the theme, and guessing would mismatch on hydration.
    const [theme, setTheme] = useState<Theme | null>(null);
    useEffect(() => {
        setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    }, []);

    const flip = (): void => {
        const next: Theme = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try {
            localStorage.setItem(KEY, next);
        } catch {
            // Private mode: the choice lasts for the tab, which is the most that can be offered.
        }
        setTheme(next);
    };

    return (
        <Button variant="ghost" size="sm" onClick={flip} aria-label="Toggle theme" title="Toggle light / dark">
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </Button>
    );
}

const SunIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
);
const MoonIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
);
