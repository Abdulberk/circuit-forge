/**
 * @jest-environment jsdom
 */
/**
 * What the last edit cost — a message the kernel has written since the connectivity work and nothing showed.
 *
 * Its own reason for existing states the loss: joining two nets leaves one name where there were two, "and a
 * user who is not told that VOUT ceased to exist will look for it later and conclude the editor lost it."
 * That is data going missing with no report — the loudest possible case of a message with no surface.
 */

import { render, fireEvent } from '@testing-library/react';

import { EditNotes } from './EditNotes';

describe('what the edit cost', () => {
    it('says nothing for the great majority of edits, which cost nothing', () => {
        const { queryByTestId } = render(<EditNotes notes={[]} />);
        expect(queryByTestId('edit-notes')).toBeNull();
    });

    it('reports the name an edit took with it', () => {
        const { getByTestId } = render(<EditNotes notes={['MID merged into VOUT.']} />);
        expect(getByTestId('edit-notes').textContent).toContain('MID merged into VOUT.');
    });

    it('reports EVERY note, not just the first — one gesture can cost several things', () => {
        const notes = ['MID merged into VOUT.', 'R4 pin 2 is now on N7.', 'GND is left with a single pin.'];
        const { getByTestId } = render(<EditNotes notes={notes} />);
        for (const note of notes) expect(getByTestId('edit-notes').textContent).toContain(note);
    });

    it('is announced as a STATUS, not an alert', () => {
        // These describe edits that were MADE, at the user's request, correctly. The refusal banner beside it
        // is for edits that did not happen. A screen reader that heard both as alarms would be told that a
        // successful edit and a rejected one sound the same.
        const { getByTestId } = render(<EditNotes notes={['MID merged into VOUT.']} />);
        expect(getByTestId('edit-notes').getAttribute('role')).toBe('status');
    });

    describe('dismissing', () => {
        it('hides the note it was pressed on', () => {
            const { getByTestId, queryByTestId } = render(<EditNotes notes={['MID merged into VOUT.']} />);
            fireEvent.click(getByTestId('edit-notes-dismiss'));
            expect(queryByTestId('edit-notes')).toBeNull();
        });

        it('does NOT swallow the next edit’s notes', () => {
            // The trap in a dismissible banner: a plain `dismissed` flag hides everything after the first
            // press, which is the same silence this component exists to end — only now the user believes
            // they turned it off once rather than for good.
            const { getByTestId, queryByTestId, rerender } = render(<EditNotes notes={['MID merged into VOUT.']} />);
            fireEvent.click(getByTestId('edit-notes-dismiss'));
            expect(queryByTestId('edit-notes')).toBeNull();

            rerender(<EditNotes notes={['N3 had no other pins and is gone.']} />);
            expect(queryByTestId('edit-notes')).not.toBeNull();
            expect(getByTestId('edit-notes').textContent).toContain('N3 had no other pins and is gone.');
        });

        it('stays dismissed while the same notes are still the last thing that happened', () => {
            // A re-render for an unrelated reason — a pan, a selection — must not bring it back. It would
            // read as a message repeating itself, which is how a notice becomes something people click away
            // without reading.
            //
            // THE SAME ARRAY, which is what an unrelated re-render actually passes: `useDocument` holds the
            // notes in state and only replaces them on a commit. This first passed `[...notes]` — a new
            // array with the same words — which does not model a re-render at all, it models a NEW EDIT, and
            // a new edit is exactly the thing that must come back.
            const notes = ['MID merged into VOUT.'];
            const { getByTestId, queryByTestId, rerender } = render(<EditNotes notes={notes} />);
            fireEvent.click(getByTestId('edit-notes-dismiss'));
            rerender(<EditNotes notes={notes} />);
            expect(queryByTestId('edit-notes')).toBeNull();
        });

        it('shows a LATER edit whose words happen to be identical', () => {
            // THE DEFECT. `duplicateComponents` emits a note that names no ids — "Copied 2 parts; connections
            // among them were kept, connections to the rest of the design were not." — so keying the
            // dismissal on the TEXT silenced every later copy of the same size, each of which dropped
            // different connections. Two edits are two edits however alike their words.
            const first = ['Copied 2 parts; connections among them were kept.'];
            const second = ['Copied 2 parts; connections among them were kept.'];
            const { getByTestId, queryByTestId, rerender } = render(<EditNotes notes={first} />);
            fireEvent.click(getByTestId('edit-notes-dismiss'));
            expect(queryByTestId('edit-notes')).toBeNull();
            rerender(<EditNotes notes={second} />);
            expect(queryByTestId('edit-notes')).not.toBeNull();
        });
    });
});
