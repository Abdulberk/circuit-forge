/**
 * @jest-environment jsdom
 */
/**
 * The undo keybinding, and the one place it must stand down.
 *
 * Inside a text field Ctrl+Z means "undo my typing" — the browser's own history for that input. Hijacking it
 * would reverse a COMMITTED change while the half-typed value stayed on screen, which is the most confusing
 * possible outcome: the user sees two things change and caused neither deliberately.
 */
import { act, render, screen } from '@testing-library/react';

import { useUndoShortcuts } from './useUndoShortcuts';

function Harness({ undo, redo, enabled = true }: { undo: () => void; redo: () => void; enabled?: boolean }) {
    useUndoShortcuts({ undo, redo, enabled });
    return (
        <div>
            <input aria-label="text" defaultValue="1k" />
            <input aria-label="tickbox" type="checkbox" />
            <textarea aria-label="notes" />
            <button>plain</button>
        </div>
    );
}

const press = (
    key: string,
    mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean },
    target?: Element,
) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
    act(() => {
        (target ?? window).dispatchEvent(event);
    });
    return event;
};

describe('the document-level undo shortcut', () => {
    it('undoes on Ctrl+Z and redoes on Ctrl+Shift+Z', () => {
        const undo = jest.fn();
        const redo = jest.fn();
        render(<Harness undo={undo} redo={redo} />);

        press('z', { ctrlKey: true });
        expect({ undo: undo.mock.calls.length, redo: redo.mock.calls.length }).toEqual({ undo: 1, redo: 0 });

        press('z', { ctrlKey: true, shiftKey: true });
        expect({ undo: undo.mock.calls.length, redo: redo.mock.calls.length }).toEqual({ undo: 1, redo: 1 });
    });

    it('accepts the macOS chord and the Windows Ctrl+Y, without sniffing the platform', () => {
        const undo = jest.fn();
        const redo = jest.fn();
        render(<Harness undo={undo} redo={redo} />);

        press('z', { metaKey: true });
        press('Z', { metaKey: true, shiftKey: true }); // capital Z is what shift produces
        press('y', { ctrlKey: true });
        expect({ undo: undo.mock.calls.length, redo: redo.mock.calls.length }).toEqual({ undo: 1, redo: 2 });
    });

    it('prevents the browser default, so the page does not also act on it', () => {
        render(<Harness undo={jest.fn()} redo={jest.fn()} />);
        const event = press('z', { ctrlKey: true });
        expect(event.defaultPrevented).toBe(true);
    });

    it('ignores a bare z, and anything with Alt', () => {
        const undo = jest.fn();
        render(<Harness undo={undo} redo={jest.fn()} />);
        press('z', {});
        press('z', { ctrlKey: true, altKey: true });
        expect(undo).not.toHaveBeenCalled();
    });

    it("STANDS DOWN inside a text input and a textarea — that is the field's own undo", () => {
        const undo = jest.fn();
        render(<Harness undo={undo} redo={jest.fn()} />);

        const event = press('z', { ctrlKey: true }, screen.getByLabelText('text'));
        expect(undo).not.toHaveBeenCalled();
        // …and it does NOT preventDefault, so the browser's own field history still runs.
        expect(event.defaultPrevented).toBe(false);

        press('z', { ctrlKey: true }, screen.getByLabelText('notes'));
        expect(undo).not.toHaveBeenCalled();
    });

    it('still fires from a checkbox and a button, which have no text history of their own', () => {
        const undo = jest.fn();
        render(<Harness undo={undo} redo={jest.fn()} />);

        press('z', { ctrlKey: true }, screen.getByLabelText('tickbox'));
        press('z', { ctrlKey: true }, screen.getByText('plain'));
        expect(undo).toHaveBeenCalledTimes(2);
    });

    it('removes its listener on unmount — a long session must not accumulate handlers', () => {
        const undo = jest.fn();
        const { unmount } = render(<Harness undo={undo} redo={jest.fn()} />);
        unmount();
        press('z', { ctrlKey: true });
        expect(undo).not.toHaveBeenCalled();
    });

    it('binds nothing at all when disabled', () => {
        const undo = jest.fn();
        render(<Harness undo={undo} redo={jest.fn()} enabled={false} />);
        press('z', { ctrlKey: true });
        expect(undo).not.toHaveBeenCalled();
    });
});
