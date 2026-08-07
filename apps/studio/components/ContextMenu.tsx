'use client';

/**
 * The verbs, at the pointer.
 *
 * WHY A MENU AT ALL. Every verb this editor has was reachable only by a key: R turns, X and Y mirror, Delete
 * removes, Ctrl+D copies. None of them is written down anywhere in the product, so the way to find out what
 * an editor can do is to already know. A right-click is where people look, and a menu is the only surface
 * that can say "this is what you may do to the thing you are pointing at" — which is also the only way the
 * alignment commands can exist at all, there being no free letter left for them.
 *
 * IT OWNS NO BEHAVIOUR. Every entry calls back out; what a verb means stays where it already lives. A menu
 * that reimplemented "rotate" would be a second answer to a question the canvas already answers, and the day
 * they disagreed the same design would turn one way from the keyboard and another from the menu.
 */

import { useEffect, useRef } from 'react';

export interface MenuItem {
    label: string;
    /** The shortcut, shown rather than hidden — a menu is where people learn the keys. */
    keys?: string;
    /** Absent means the item is shown greyed: what it needs is stated by its presence, not by disappearing. */
    run?: () => void;
}

export function ContextMenu({
    at,
    items,
    onClose,
}: {
    at: { x: number; y: number } | null;
    items: readonly (MenuItem | 'separator')[];
    onClose: () => void;
}): React.JSX.Element | null {
    const box = useRef<HTMLDivElement | null>(null);

    /**
     * Anything that is not this menu closes it — a click elsewhere, Escape, a scroll, another right-click.
     *
     * Registered while it is OPEN and torn down with it, because a listener that outlives the thing it
     * serves is the shape that ends up closing a menu somebody opened afterwards.
     */
    useEffect(() => {
        if (!at) return;
        const away = (e: Event) => {
            if (!box.current?.contains(e.target as Node)) onClose();
        };
        const key = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        // Captured, so a click on something that stops propagation still closes the menu.
        window.addEventListener('pointerdown', away, true);
        window.addEventListener('keydown', key);
        window.addEventListener('resize', onClose);
        return () => {
            window.removeEventListener('pointerdown', away, true);
            window.removeEventListener('keydown', key);
            window.removeEventListener('resize', onClose);
        };
    }, [at, onClose]);

    if (!at) return null;

    return (
        <div
            ref={box}
            role="menu"
            data-testid="context-menu"
            style={{
                position: 'fixed',
                // Kept ON SCREEN. A menu opened near the right or bottom edge would otherwise open off it,
                // and the items a user most wants — the ones at the bottom — are the ones that vanish.
                left: Math.min(at.x, Math.max(0, (typeof window === 'undefined' ? 1024 : window.innerWidth) - 220)),
                top: Math.min(at.y, Math.max(0, (typeof window === 'undefined' ? 768 : window.innerHeight) - 320)),
                zIndex: 50,
                minWidth: 200,
                padding: '4px 0',
                borderRadius: 6,
                background: 'var(--panel-raised, #222)',
                border: '1px solid var(--border, #333)',
                boxShadow: '0 8px 24px rgba(0,0,0,.4)',
            }}
        >
            {items.map((item, i) =>
                item === 'separator' ? (
                    <div key={`sep${i}`} style={{ height: 1, margin: '4px 0', background: 'var(--border, #333)' }} />
                ) : (
                    <button
                        key={item.label}
                        type="button"
                        role="menuitem"
                        disabled={!item.run}
                        onClick={() => {
                            item.run?.();
                            onClose();
                        }}
                        style={{
                            display: 'flex',
                            width: '100%',
                            gap: 16,
                            justifyContent: 'space-between',
                            padding: '5px 12px',
                            background: 'transparent',
                            border: 0,
                            textAlign: 'left',
                            cursor: item.run ? 'pointer' : 'default',
                            opacity: item.run ? 1 : 0.45,
                        }}
                    >
                        <span>{item.label}</span>
                        {item.keys && <span style={{ color: 'var(--text-dim, #888)' }}>{item.keys}</span>}
                    </button>
                ),
            )}
        </div>
    );
}
