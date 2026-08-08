/**
 * @jest-environment jsdom
 */
/**
 * The one thing on screen that tells a user whether their work still exists.
 *
 * An autosaving editor asks people to trust something they cannot see, so the cost of getting this wrong is
 * not a cosmetic bug — it is somebody closing a tab because the corner said "saved". Which makes it strange
 * that it had no test at all: the states below were reachable, reasoned about carefully in the source, and
 * nothing had ever checked that the reasoning reached the screen.
 *
 * The claim under test throughout is NEGATIVE: the reassuring state must be shown only when it is TRUE, and
 * every state where work is at risk must be unmissable and must never resolve itself.
 */

import { render, fireEvent } from '@testing-library/react';

import { ApiError } from '../lib/api/errors';
import type { DocumentState } from '../lib/useDocument';

import { SaveStatus } from './SaveStatus';

/** A document in the ordinary saved state; each test names only what it is about. */
const docWith = (over: Partial<DocumentState> = {}): DocumentState =>
    ({
        circuit: null,
        ui: { schemaVersion: 1 },
        save: { status: 'clean', savedAt: '2026-08-08T09:15:00.000Z' },
        recovery: null,
        localBackup: { ok: true },
        notes: [],
        refusal: null,
        flush: jest.fn(),
        takeTheirs: jest.fn(),
        overwriteWithMine: jest.fn(),
        recoverLocal: jest.fn(),
        discardLocal: jest.fn(),
        ...over,
    }) as unknown as DocumentState;

const textOf = (el: HTMLElement) => el.textContent ?? '';

describe('whether the work is safe', () => {
    describe('the quiet states, which live in the status bar', () => {
        it('says when it last saved', () => {
            const { container } = render(<SaveStatus doc={docWith()} />);
            expect(textOf(container)).toMatch(/saved /);
        });

        it('distinguishes "nothing has happened yet" from "saved"', () => {
            // A document nobody has edited has never been saved, and saying "saved" about it would be a
            // claim about a round trip that never took place.
            const { container } = render(<SaveStatus doc={docWith({ save: { status: 'clean', savedAt: null } })} />);
            expect(textOf(container)).toContain('no changes yet');
            expect(textOf(container)).not.toMatch(/saved /);
        });

        it('says plainly when there are changes the server does not have', () => {
            const { container } = render(<SaveStatus doc={docWith({ save: { status: 'dirty' } })} />);
            expect(textOf(container)).toContain('unsaved changes');
        });

        it('does not put a panel in the way for any of them', () => {
            // An editor that shows a box for "saved" trains people to ignore boxes — and then the box that
            // matters is the one they dismiss without reading.
            for (const save of [
                { status: 'clean', savedAt: '2026-08-08T09:15:00.000Z' },
                { status: 'dirty' },
                { status: 'saving' },
            ] as const) {
                const { container } = render(<SaveStatus doc={docWith({ save })} />);
                expect(container.querySelector('[role="alert"]')).toBeNull();
            }
        });
    });

    describe('the states where work is at risk', () => {
        it('makes a conflict unmissable, and never resolves it', () => {
            // Two saved documents disagreeing. A merge invented here could silently pick wrong, so the only
            // two honest options are theirs or yours — and both must be offered.
            const takeTheirs = jest.fn();
            const overwriteWithMine = jest.fn();
            const { container, getByText } = render(
                <SaveStatus
                    doc={docWith({
                        save: { status: 'conflict', theirUpdatedAt: '2026-08-08T09:20:00.000Z' },
                        takeTheirs,
                        overwriteWithMine,
                    })}
                />,
            );
            expect(container.querySelector('[role="alert"]')).not.toBeNull();
            // The reassurance that must NOT appear: the user's changes are still only on this machine.
            expect(textOf(container)).not.toMatch(/saved \d/);
            expect(textOf(container)).toMatch(/have NOT been sent/);

            fireEvent.click(getByText(/Save mine, overwrite theirs/));
            fireEvent.click(getByText(/Discard mine, load theirs/));
            expect(overwriteWithMine).toHaveBeenCalledTimes(1);
            expect(takeTheirs).toHaveBeenCalledTimes(1);
        });

        it('offers a retry for a failure that could succeed, and none for one that cannot', () => {
            // REAL failures, not stand-ins with a `retryable` field written by hand. Whether a failure can be
            // retried is DERIVED from what kind it was — a lost network can be, a refused permission cannot —
            // so a made-up object would test the button against a rule this app does not use.
            const flush = jest.fn();
            const retryable = render(
                <SaveStatus
                    doc={docWith({
                        save: { status: 'error', error: new ApiError('network', 'Network unreachable') },
                        flush,
                    })}
                />,
            );
            expect(textOf(retryable.container)).toContain('Network unreachable');
            fireEvent.click(retryable.getByText(/Try again/));
            expect(flush).toHaveBeenCalledTimes(1);

            const permanent = render(
                <SaveStatus
                    doc={docWith({
                        save: { status: 'error', error: new ApiError('forbidden', 'You cannot edit this project') },
                    })}
                />,
            );
            // A button that cannot work is worse than none: it invites the user to keep pressing while the
            // work stays unsaved.
            expect(permanent.container.querySelector('button')).toBeNull();
        });

        it('puts recovered local work AHEAD of everything else', () => {
            // A conflict is two saved documents disagreeing. This is one UNSAVED document that survived a tab
            // closing — it exists nowhere else, and it is gone the moment the user edits over it. So it wins
            // even when the save state is also shouting.
            const { container } = render(
                <SaveStatus
                    doc={docWith({
                        save: { status: 'conflict', theirUpdatedAt: null },
                        recovery: {
                            circuit: null as never,
                            ui: null as never,
                            at: '2026-08-08T08:00:00.000Z',
                            continuesServerDraft: true,
                        },
                    })}
                />,
            );
            expect(textOf(container)).toContain('Unsaved work found on this device');
            expect(textOf(container)).not.toContain('Someone else saved first');
        });

        it('says whether restoring would cost anything, because the two cases are not the same', () => {
            const continues = render(
                <SaveStatus
                    doc={docWith({
                        recovery: {
                            circuit: null as never,
                            ui: null as never,
                            at: '2026-08-08T08:00:00.000Z',
                            continuesServerDraft: true,
                        },
                    })}
                />,
            );
            expect(textOf(continues.container)).toMatch(/continue exactly the draft/);

            const diverged = render(
                <SaveStatus
                    doc={docWith({
                        recovery: {
                            circuit: null as never,
                            ui: null as never,
                            at: '2026-08-08T08:00:00.000Z',
                            continuesServerDraft: false,
                        },
                    })}
                />,
            );
            // The user is being asked to choose, so they have to be told what the choice costs.
            expect(textOf(diverged.container)).toMatch(/would have to be redone/);
        });

        it('offers both answers to recovered work, and calls the one that was pressed', () => {
            const recoverLocal = jest.fn();
            const discardLocal = jest.fn();
            const { getByText } = render(
                <SaveStatus
                    doc={docWith({
                        recovery: {
                            circuit: null as never,
                            ui: null as never,
                            at: '2026-08-08T08:00:00.000Z',
                            continuesServerDraft: true,
                        },
                        recoverLocal,
                        discardLocal,
                    })}
                />,
            );
            fireEvent.click(getByText(/Restore my unsaved work/));
            fireEvent.click(getByText(/Discard it, keep what is open/));
            expect(recoverLocal).toHaveBeenCalledTimes(1);
            expect(discardLocal).toHaveBeenCalledTimes(1);
        });
    });

    describe('the local backup', () => {
        it('is mentioned ONLY when it has failed', () => {
            // A permanent "backed up ✓" is the badge people stop reading. The only reason this exists is
            // that "unsaved changes" means something different when nothing is holding them: on this browser
            // they would not survive the tab.
            const working = render(<SaveStatus doc={docWith()} />);
            expect(textOf(working.container)).not.toContain('not kept on this device');

            const broken = render(
                <SaveStatus doc={docWith({ localBackup: { ok: false, message: 'Storage is full' } as never })} />,
            );
            expect(textOf(broken.container)).toContain('not kept on this device');
        });
    });

    it('does not report what an EDIT cost — that is a different question, asked elsewhere', () => {
        // It used to, wedged above the save label. "Your edit merged two nets" and "the server has your
        // work" are two different questions, and one indicator answering both means neither is read as an
        // answer to anything. The notes now sit beside the drawing, where the edit happened.
        const { container } = render(<SaveStatus doc={docWith({ notes: ['MID merged into VOUT.'] })} />);
        expect(textOf(container)).not.toContain('MID merged into VOUT.');
    });
});
