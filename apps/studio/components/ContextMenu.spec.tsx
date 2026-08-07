/**
 * @jest-environment jsdom
 */
/**
 * The menu that tells a user what the editor can do.
 *
 * Every verb was reachable only by a key and none of them is written down anywhere, so the way to find out
 * what this editor could do was to already know. A menu is also the only place the alignment commands could
 * live — there is no free letter left, and nobody guesses a chord for "line these five up".
 */
import { render, screen, fireEvent } from '@testing-library/react';

import { ContextMenu } from './ContextMenu';

describe('the verbs, at the pointer', () => {
    it('shows what may be done, and what may not — greyed rather than gone', () => {
        // A menu that changes shape teaches nothing. "Why can I not align one part" is answered by seeing
        // the entry disabled; hiding it leaves the user to wonder whether the feature exists.
        render(
            <ContextMenu
                at={{ x: 10, y: 10 }}
                onClose={() => {}}
                items={[{ label: 'Rotate', keys: 'R', run: () => {} }, { label: 'Align left' }]}
            />,
        );
        expect((screen.getByText('Rotate').closest('button') as HTMLButtonElement).disabled).toBe(false);
        expect((screen.getByText('Align left').closest('button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows the shortcut, because a menu is where people learn the keys', () => {
        render(
            <ContextMenu
                at={{ x: 10, y: 10 }}
                onClose={() => {}}
                items={[{ label: 'Duplicate', keys: 'Ctrl+D', run: () => {} }]}
            />,
        );
        expect(screen.getByText('Ctrl+D')).toBeTruthy();
    });

    it('runs the entry and closes, in that order', () => {
        const order: string[] = [];
        render(
            <ContextMenu
                at={{ x: 10, y: 10 }}
                onClose={() => order.push('closed')}
                items={[{ label: 'Rotate', run: () => order.push('ran') }]}
            />,
        );
        fireEvent.click(screen.getByText('Rotate'));
        expect(order).toEqual(['ran', 'closed']);
    });

    it('closes on Escape and on a press anywhere else', () => {
        const closed: string[] = [];
        const { rerender } = render(
            <ContextMenu
                at={{ x: 10, y: 10 }}
                onClose={() => closed.push('esc')}
                items={[{ label: 'Rotate', run: () => {} }]}
            />,
        );
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(closed).toEqual(['esc']);

        rerender(
            <ContextMenu
                at={{ x: 10, y: 10 }}
                onClose={() => closed.push('away')}
                items={[{ label: 'Rotate', run: () => {} }]}
            />,
        );
        fireEvent.pointerDown(document.body);
        expect(closed).toEqual(['esc', 'away']);
    });

    it('a press INSIDE it does not close it', () => {
        // Otherwise the menu closes before the click it was opened for can land.
        const closed: string[] = [];
        render(
            <ContextMenu
                at={{ x: 10, y: 10 }}
                onClose={() => closed.push('x')}
                items={[{ label: 'Rotate', run: () => {} }]}
            />,
        );
        fireEvent.pointerDown(screen.getByTestId('context-menu'));
        expect(closed).toEqual([]);
    });

    it('is not there when it is not open, and listens to nothing', () => {
        // A listener that outlives the thing it serves is the shape that ends up closing a menu somebody
        // opened afterwards.
        const closed: string[] = [];
        const { container } = render(
            <ContextMenu at={null} onClose={() => closed.push('x')} items={[{ label: 'Rotate', run: () => {} }]} />,
        );
        expect(container.firstChild).toBeNull();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(closed).toEqual([]);
    });

    it('stays on screen when opened near an edge', () => {
        // The items a user most wants are at the bottom, and those are the ones that vanish off it.
        render(
            <ContextMenu at={{ x: 99999, y: 99999 }} onClose={() => {}} items={[{ label: 'Rotate', run: () => {} }]} />,
        );
        const box = screen.getByTestId('context-menu');
        expect(Number.parseFloat(box.style.left)).toBeLessThan(window.innerWidth);
        expect(Number.parseFloat(box.style.top)).toBeLessThan(window.innerHeight);
    });
});
