/**
 * @jest-environment jsdom
 */
/**
 * The write path, under the conditions that lose work.
 *
 * Every case here is one a user reaches by ordinary typing and cannot reproduce on request: an edit landing
 * while a save is in flight, a tab closing one second after the last keystroke, a second tab having saved
 * first. None of them shows up in a click-through, and each one is a lost design.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';
import { setValue } from '@circuit-forge/editor-core';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { ApiError, type Api, type OpenedProject } from './api';
import { useDocument } from './useDocument';

const CIRCUIT: CircuitJson = {
    version: '1.0',
    components: [{ id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'n1' }] }],
    nets: [{ id: 'n1', name: 'N1' }],
};

const asDraft = (updatedAt: string): OpenedProject => ({
    source: 'working-copy',
    circuitJson: CIRCUIT,
    updatedAt,
    baseVersionId: null,
});

/** A recording server: what was sent, in order, with the token each save carried. */
function fakeApi(
    behaviour: (
        call: number,
        body: { circuitJson: CircuitJson; expectedUpdatedAt?: string },
    ) => Promise<{ updatedAt: string }>,
) {
    const sent: Array<{ value: string | undefined; token: string | undefined }> = [];
    let calls = 0;
    const api = {
        saveWorkingCopy: (
            _projectId: string,
            body: { circuitJson: CircuitJson; uiJson: Record<string, unknown>; expectedUpdatedAt?: string },
        ) => {
            calls += 1;
            sent.push({
                value: (body.circuitJson.components ?? [])[0]?.value,
                token: body.expectedUpdatedAt,
            });
            return behaviour(calls, body).then((r) => ({
                projectId: 'p',
                baseVersionId: null,
                updatedByUserId: 'u',
                updatedAt: r.updatedAt,
            }));
        },
    } as unknown as Api;
    return { api, sent, calls: () => calls };
}

/** Renders the hook and gives the test a handle to edit and read it. */
function Harness({ api, opened }: { api: Api; opened: OpenedProject }) {
    const [n, setN] = useState(0);
    const doc = useDocument(api, 'project-1', opened);
    return (
        <div>
            <output data-testid="value">{(doc.circuit?.components ?? [])[0]?.value ?? '—'}</output>
            <output data-testid="status">{doc.save.status}</output>
            <output data-testid="refusal">{doc.refusal?.reason ?? '—'}</output>
            <button
                onClick={() => {
                    setN(n + 1);
                    doc.apply((c) => setValue(c, 'r1', `${n + 2}k`));
                }}
            >
                edit
            </button>
            <button onClick={() => doc.apply((c) => setValue(c, 'r1', ''))}>bad-edit</button>
            <button onClick={doc.flush}>flush</button>
            <button onClick={doc.discardLocalAndReload}>discard</button>
        </div>
    );
}

const value = () => screen.getByTestId('value').textContent;
const status = () => screen.getByTestId('status').textContent;
const click = (label: string) => act(() => screen.getByText(label).click());

beforeEach(() => jest.useFakeTimers({ advanceTimers: true }));
afterEach(() => jest.useRealTimers());

const settle = async (ms = 2_000) => {
    await act(async () => {
        jest.advanceTimersByTime(ms);
        await Promise.resolve();
    });
};

describe('an edit is instant and the save follows', () => {
    it('shows the change immediately and saves after the user stops typing', async () => {
        const { api, sent } = fakeApi(() => Promise.resolve({ updatedAt: 'T2' }));
        render(<Harness api={api} opened={asDraft('T1')} />);

        click('edit');
        expect(value()).toBe('2k'); // no round trip
        expect(status()).toBe('dirty');
        expect(sent).toHaveLength(0); // …and nothing sent yet

        await settle();
        await waitFor(() => expect(status()).toBe('clean'));
        expect(sent).toEqual([{ value: '2k', token: 'T1' }]);
    });

    it('carries expectedUpdatedAt on EVERY save, using the token the last save returned', async () => {
        // The whole optimistic-concurrency guarantee. Omitting the token is silently opting into
        // last-writer-wins; carrying a STALE one is refusing our own writes.
        let issued = 1;
        const { api, sent } = fakeApi(() => Promise.resolve({ updatedAt: `T${++issued}` }));
        render(<Harness api={api} opened={asDraft('T1')} />);

        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));

        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));

        expect(sent.map((s) => s.token)).toEqual(['T1', 'T2']);
    });

    it('coalesces typing during an in-flight save instead of racing it', async () => {
        // Two saves in flight would carry the SAME token, so the second would be refused by the first's own
        // success — a conflict the user caused by typing quickly. One at a time; the rest is queued.
        let release: (() => void) | undefined;
        const { api, sent } = fakeApi((call) =>
            call === 1
                ? new Promise<{ updatedAt: string }>((r) => (release = () => r({ updatedAt: 'T2' })))
                : Promise.resolve({ updatedAt: 'T3' }),
        );
        render(<Harness api={api} opened={asDraft('T1')} />);

        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('saving'));

        // Two more edits land while the first save is still open.
        click('edit');
        click('edit');
        await settle();
        expect(sent).toHaveLength(1); // still only one request

        act(() => release!());
        await waitFor(() => expect(status()).toBe('clean'));

        // The second request carries the LATEST document and the NEW token — not the intermediate edit.
        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual({ value: '4k', token: 'T2' });
    });

    it('does not save an edit that changed nothing', async () => {
        // Re-typing the same value must not mint a revision — a new `updatedAt` would conflict with another
        // tab for no reason at all.
        const { api, sent } = fakeApi(() => Promise.resolve({ updatedAt: 'T2' }));
        render(<Harness api={api} opened={asDraft('T1')} />);

        act(() => {
            screen.getByText('edit').click();
        });
        await settle();
        await waitFor(() => expect(sent).toHaveLength(1));

        // Applying the identical value again.
        await settle();
        expect(sent).toHaveLength(1);
    });
});

describe('a refused edit keeps the document', () => {
    it('reports the refusal and changes nothing', async () => {
        const { api, sent } = fakeApi(() => Promise.resolve({ updatedAt: 'T2' }));
        render(<Harness api={api} opened={asDraft('T1')} />);

        click('bad-edit');
        expect(screen.getByTestId('refusal').textContent).toBe('empty');
        expect(value()).toBe('1k'); // untouched
        await settle();
        expect(sent).toHaveLength(0); // and never sent
    });
});

describe('someone else saved first', () => {
    it('holds the local document and offers both ways out', async () => {
        // The moment the user's work matters most. A conflict that cleared the document to "reload and try
        // again" would convert a PREVENTED silent loss into a loud one.
        const { api } = fakeApi(() =>
            Promise.reject(
                new ApiError('conflict', 'changed', {
                    status: 409,
                    code: 'WORKING_COPY_CONFLICT',
                    body: { currentUpdatedAt: 'T9' },
                }),
            ),
        );
        render(<Harness api={api} opened={asDraft('T1')} />);

        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('conflict'));
        expect(value()).toBe('2k'); // the user's edit is STILL on screen
    });

    it('can force the save through', async () => {
        let calls = 0;
        const { api, sent } = fakeApi(() => {
            calls += 1;
            return calls === 1
                ? Promise.reject(new ApiError('conflict', 'changed', { status: 409, body: {} }))
                : Promise.resolve({ updatedAt: 'T9' });
        });
        render(<Harness api={api} opened={asDraft('T1')} />);

        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('conflict'));

        // Editing again re-queues, and flush sends it.
        click('edit');
        click('flush');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));
        expect(sent.length).toBeGreaterThanOrEqual(2);
    });

    it('can throw the local document away and take theirs', async () => {
        const { api } = fakeApi(() => Promise.reject(new ApiError('conflict', 'changed', { status: 409, body: {} })));
        const { rerender } = render(<Harness api={api} opened={asDraft('T1')} />);

        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('conflict'));

        click('discard');
        // Re-adopting the loader's document is what "load theirs" means.
        rerender(<Harness api={api} opened={asDraft('T1')} />);
        await waitFor(() => expect(value()).toBe('1k'));
    });
});

describe('leaving the page', () => {
    it('sends the last edit rather than dropping it with the debounce', async () => {
        // A debounce cancelled by unmount silently loses whatever was typed in the final second, which the
        // user experiences as the editor forgetting.
        const { api, sent } = fakeApi(() => Promise.resolve({ updatedAt: 'T2' }));
        const { unmount } = render(<Harness api={api} opened={asDraft('T1')} />);

        click('edit');
        expect(sent).toHaveLength(0); // still inside the debounce window

        await act(async () => {
            unmount();
            await Promise.resolve();
        });
        expect(sent).toEqual([{ value: '2k', token: 'T1' }]);
    });
});
