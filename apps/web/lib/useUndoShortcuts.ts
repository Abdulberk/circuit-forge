'use client';

/**
 * Ctrl+Z and Ctrl+Shift+Z (⌘Z / ⌘⇧Z), bound once at the window.
 *
 * WHY NOT ON A CONTAINER. Undo is global to the document, not to whatever happens to have focus, and a
 * handler on a div only fires when focus is inside it. A user who has just clicked the canvas, or nothing at
 * all, still expects Ctrl+Z to work.
 *
 * WHY IT STANDS DOWN INSIDE A TEXT FIELD. While someone is typing in an input, Ctrl+Z means "undo my typing"
 * — the browser's own edit history for that field — and hijacking it would make the editor reverse a
 * COMMITTED change while the half-typed value stays on screen. The field's own undo is the correct behaviour
 * there, so this yields to it, and the moment the field is blurred (which is when the value is committed)
 * the document-level shortcut applies again.
 */
import { useEffect } from 'react';

/**
 * Is the event coming from somewhere with its own text-editing undo?
 *
 * EXPORTED because every keyboard shortcut this editor grows needs exactly this question, and a second
 * implementation of it is a second answer. `R` rotates a part — so without this check, typing a resistance
 * of `4R7` into the Inspector would silently turn the part behind the panel.
 */
export function isTextEntry(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    if (tag === 'TEXTAREA') return true;
    // A <select> types too. Its own type-ahead jumps to the option whose label starts with the letter, so a
    // bare shortcut fired from one both steals the keystroke and does something elsewhere: pressing R while
    // the project picker had focus turned a part behind the panel instead of finding the project beginning
    // with R, and F threw away the view the user was looking at.
    if (tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    // A checkbox or a button has no text history of its own, so the document shortcut still applies.
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
}

export function useUndoShortcuts({
    undo,
    redo,
    enabled = true,
}: {
    undo: () => void;
    redo: () => void;
    enabled?: boolean;
}): void {
    useEffect(() => {
        if (!enabled) return;

        const onKeyDown = (event: KeyboardEvent) => {
            // `metaKey` for macOS, `ctrlKey` elsewhere. Accepting either means one binding works on both
            // without sniffing the platform, and no real keyboard produces both at once for this chord.
            if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
            const key = event.key.toLowerCase();
            if (key !== 'z' && key !== 'y') return;
            if (isTextEntry(event.target)) return;

            // Ctrl+Y is the Windows convention for redo and costs nothing to accept alongside Ctrl+Shift+Z.
            const wantsRedo = key === 'y' || event.shiftKey;
            event.preventDefault();
            if (wantsRedo) redo();
            else undo();
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [undo, redo, enabled]);
}
