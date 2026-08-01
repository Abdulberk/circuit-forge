/**
 * @jest-environment jsdom
 */
/**
 * The write path, under the conditions that lose work.
 *
 * THE FAKE SERVER ENFORCES THE TOKEN. The first version of this file did not, and that one shortcut made the
 * two most important tests unable to fail: "force the save through" passed against a server that would have
 * accepted anything, so it certified a button that in reality re-sent a token the server had already refused
 * and looped on 409 forever. A fake more permissive than the real thing is not a test of the client; it is a
 * test of the fake.
 *
 * `conditionalSave` below implements the API's actual rule (working-copy.service.ts): a save carrying
 * `expectedUpdatedAt` succeeds only if it matches the current row, a save omitting it always succeeds, and
 * every accepted write moves the token. Every conflict case runs against that.
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

const asDraft = (updatedAt: string, baseVersionId: string | null = null): OpenedProject => ({
    source: 'working-copy',
    circuitJson: CIRCUIT,
    updatedAt,
    baseVersionId,
});

interface SaveCall {
    projectId: string;
    value: string | undefined;
    token: string | undefined;
    baseVersionId: string | undefined;
}

/** A server that behaves like the real one: it holds a row, enforces the precondition, and moves the token. */
function conditionalSave(initialUpdatedAt: string) {
    const sent: SaveCall[] = [];
    let current = initialUpdatedAt;
    let issued = 0;

    /** Another tab writes — the row moves without this client knowing. */
    const somebodyElseSaves = () => {
        current = `X${++issued}`;
    };

    const api = {
        saveWorkingCopy: (
            projectId: string,
            body: {
                circuitJson: CircuitJson;
                uiJson: Record<string, unknown>;
                baseVersionId?: string;
                expectedUpdatedAt?: string;
            },
        ) => {
            sent.push({
                projectId,
                value: (body.circuitJson.components ?? [])[0]?.value,
                token: body.expectedUpdatedAt,
                baseVersionId: body.baseVersionId,
            });
            if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== current) {
                // Exactly the API's 409: the conditional update matched zero rows.
                return Promise.reject(
                    new ApiError('conflict', 'The working copy changed since you loaded it', {
                        status: 409,
                        code: 'WORKING_COPY_CONFLICT',
                        body: { currentUpdatedAt: current },
                    }),
                );
            }
            current = `T${++issued}`;
            return Promise.resolve({
                projectId,
                baseVersionId: body.baseVersionId ?? null,
                updatedByUserId: 'u',
                updatedAt: current,
            });
        },
    } as unknown as Api;

    return { api, sent, somebodyElseSaves, currentToken: () => current };
}

function Harness({
    api,
    opened,
    projectId = 'project-1',
    onReload,
}: {
    api: Api;
    opened: OpenedProject;
    projectId?: string;
    onReload?: () => void;
}) {
    const [n, setN] = useState(0);
    const doc = useDocument(api, projectId, opened, onReload ?? (() => {}));
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
            <button onClick={doc.overwriteWithMine}>overwrite</button>
            <button onClick={doc.takeTheirs}>take-theirs</button>

            <output data-testid="canUndo">{String(doc.canUndo)}</output>
            <output data-testid="canRedo">{String(doc.canRedo)}</output>
            <button onClick={doc.undo}>undo</button>
            <button onClick={doc.redo}>redo</button>
            {/* Two edits in one commit: one undo step, and all-or-nothing. */}
            <button
                onClick={() =>
                    doc.applyMany('Compound', [(c) => setValue(c, 'r1', '5k'), (c) => setValue(c, 'r1', '9k')])
                }
            >
                compound
            </button>
            <button
                onClick={() =>
                    doc.applyMany('Bad compound', [(c) => setValue(c, 'r1', '5k'), (c) => setValue(c, 'r1', '')])
                }
            >
                bad-compound
            </button>
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
        await Promise.resolve();
    });
};

describe('an edit is instant and the save follows', () => {
    it('shows the change immediately and saves after the user stops typing', async () => {
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        click('edit');
        expect(value()).toBe('2k'); // no round trip
        expect(status()).toBe('dirty');
        expect(sent).toHaveLength(0); // …and nothing sent yet

        await settle();
        await waitFor(() => expect(status()).toBe('clean'));
        expect(sent).toEqual([{ projectId: 'project-1', value: '2k', token: 'T0', baseVersionId: undefined }]);
    });

    it('carries the token the LAST save returned, so consecutive saves are accepted', async () => {
        // Against a token-enforcing server this IS the guarantee: carry a stale one and the second save is
        // refused by the first save's own success.
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));
        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));

        expect(sent.map((s) => s.token)).toEqual(['T0', 'T1']);
    });

    it('carries baseVersionId, so a draft branched from a version keeps its ancestry', async () => {
        // The API models "N unsaved changes since v3" from this field, and it used never to be sent — so the
        // provenance was lost on the first keystroke after opening.
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0', 'version-7')} />);

        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));
        expect(sent[0]!.baseVersionId).toBe('version-7');
    });

    it('coalesces typing during an in-flight save instead of racing it', async () => {
        const { api, sent } = conditionalSave('T0');
        let release: (() => void) | undefined;
        let first = true;
        const slow = {
            saveWorkingCopy: (p: string, b: Parameters<Api['saveWorkingCopy']>[1]) => {
                if (first) {
                    first = false;
                    return new Promise<void>((r) => (release = r)).then(() => api.saveWorkingCopy(p, b));
                }
                return api.saveWorkingCopy(p, b);
            },
        } as unknown as Api;

        render(<Harness api={slow} opened={asDraft('T0')} />);
        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('saving'));

        click('edit');
        click('edit');
        await settle();
        expect(sent).toHaveLength(0); // the first request has not reached the server yet

        act(() => release!());
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));

        expect(sent).toHaveLength(2);
        expect(sent[1]!.value).toBe('4k'); // the LATEST document, not the intermediate edit
        expect(sent[1]!.token).toBe('T1'); // …carrying the token the first save returned
    });

    it('does not save an edit that changed nothing', async () => {
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);
        click('edit');
        await settle();
        await waitFor(() => expect(sent).toHaveLength(1));
        await settle();
        expect(sent).toHaveLength(1);
    });
});

describe('undo and redo are edits, and edits are saved', () => {
    it('SAVES an undo — leaving it local would resurrect the change on reload', async () => {
        // The surprise this prevents: press Ctrl+Z, watch the change reverse, close the tab, and get the
        // un-undone version back. Same class of failure as a dropped keystroke.
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));
        expect(sent).toHaveLength(1);

        click('undo');
        expect(value()).toBe('1k'); // reversed on screen immediately
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));

        // …and the reversal went to the server, carrying the token the previous save returned.
        expect(sent).toHaveLength(2);
        expect(sent[1]).toMatchObject({ value: '1k', token: 'T1' });
    });

    it('does not save when there is nothing to undo', async () => {
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        click('undo');
        await settle();
        expect(sent).toHaveLength(0);
        expect(status()).toBe('clean');
    });

    it('redo puts the change back, and saves that too', async () => {
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));
        click('undo');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));

        click('redo');
        expect(value()).toBe('2k');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));
        expect(sent[sent.length - 1]).toMatchObject({ value: '2k' });
    });

    it('reports whether there is anything to undo, so a button can be honestly disabled', async () => {
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        expect(screen.getByTestId('canUndo').textContent).toBe('false');
        click('edit');
        await settle();
        expect(screen.getByTestId('canUndo').textContent).toBe('true');
        expect(screen.getByTestId('canRedo').textContent).toBe('false');

        click('undo');
        await settle();
        expect(screen.getByTestId('canRedo').textContent).toBe('true');
    });

    it('ADOPTING a server document clears the history — nothing can be undone across it', async () => {
        // Undoing past a document this editor did not author would restore state predating whatever the
        // other author saved, quietly resurrecting work they had already replaced.
        const { api } = conditionalSave('T0');
        const { rerender } = render(<Harness api={api} opened={asDraft('T0')} />);

        click('edit');
        await settle();
        expect(screen.getByTestId('canUndo').textContent).toBe('true');

        rerender(<Harness api={api} opened={asDraft('T5')} />);
        await waitFor(() => expect(screen.getByTestId('canUndo').textContent).toBe('false'));
    });

    it('applies a compound edit as ONE undo step', async () => {
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        click('compound'); // two edits in one commit
        await settle();
        expect(value()).toBe('9k');

        click('undo');
        expect(value()).toBe('1k'); // both reversed, by one press
        await settle();
        expect(screen.getByTestId('canUndo').textContent).toBe('false');
    });

    it('a refused member refuses the WHOLE compound edit', async () => {
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        click('bad-compound'); // second member is invalid
        expect(value()).toBe('1k'); // nothing applied
        expect(screen.getByTestId('refusal').textContent).toBe('empty');
        await settle();
        expect(sent).toHaveLength(0);
        expect(screen.getByTestId('canUndo').textContent).toBe('false');
    });
});

describe('a refused edit keeps the document', () => {
    it('reports the refusal and changes nothing', async () => {
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        click('bad-edit');
        expect(screen.getByTestId('refusal').textContent).toBe('empty');
        expect(value()).toBe('1k');
        await settle();
        expect(sent).toHaveLength(0);
    });
});

describe('getting out of a conflict — against a server that really enforces the token', () => {
    it('reaches conflict and keeps the local document on screen', async () => {
        const { api, somebodyElseSaves } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        somebodyElseSaves(); // another tab writes; our token is now stale
        click('edit');
        await settle();

        await waitFor(() => expect(status()).toBe('conflict'));
        expect(value()).toBe('2k'); // the user's edit is STILL there
    });

    it('"save mine" succeeds by DROPPING the precondition — retrying the same token never could', async () => {
        // The defect this replaces: the button called `flush`, which had nothing queued (the failing save had
        // already cleared it) and would have re-sent the refused token anyway. A no-op wrapped around an
        // impossibility — and the old test passed because its fake ignored tokens entirely.
        const { api, sent, somebodyElseSaves } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        somebodyElseSaves();
        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('conflict'));

        click('overwrite');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));

        // The forcing save carried NO token — that is what makes it able to succeed at all.
        expect(sent[sent.length - 1]).toMatchObject({ value: '2k', token: undefined });
    });

    it('a plain retry after a conflict does NOT silently succeed — the token is still stale', async () => {
        // Guards the distinction the fix rests on. If `flush` ever starts dropping the precondition, this
        // goes red — a deliberate overwrite must stay a deliberate, separate action.
        const { api, somebodyElseSaves } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        somebodyElseSaves();
        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('conflict'));

        click('flush');
        await settle();
        expect(status()).toBe('conflict'); // still refused, correctly
    });

    it('"take theirs" ASKS THE SERVER — it does not re-adopt the cached document', async () => {
        // The old version bumped a local counter, re-adopting the same cached circuit and re-installing the
        // token the server had already rejected — so the project became permanently unsaveable and the user
        // had lost their work for nothing.
        const reload = jest.fn();
        const { api, somebodyElseSaves } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} onReload={reload} />);

        somebodyElseSaves();
        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('conflict'));

        click('take-theirs');
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('adopting the server document afterwards leaves a SAVEABLE project', async () => {
        // The end state that matters: after taking theirs, the very next edit must save cleanly.
        const { api, somebodyElseSaves, currentToken } = conditionalSave('T0');
        const { rerender } = render(<Harness api={api} opened={asDraft('T0')} />);

        somebodyElseSaves();
        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('conflict'));

        // What `reloadOpened` produces: the server's current document and its current token.
        rerender(<Harness api={api} opened={asDraft(currentToken())} />);
        await waitFor(() => expect(value()).toBe('1k'));

        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));
    });
});

describe('switching projects', () => {
    it('never writes one project’s circuit into another project’s draft', async () => {
        // The refs used not to be scoped, so a save landing after a switch wrote into the wrong project,
        // poisoned the new token, and reported "saved" for a document that was never sent.
        const { api, sent } = conditionalSave('T0');
        const { rerender } = render(<Harness api={api} opened={asDraft('T0')} projectId="project-1" />);

        click('edit');
        rerender(<Harness api={api} opened={asDraft('S0')} projectId="project-2" />);
        await settle();

        for (const call of sent) {
            expect(call.projectId).toBe('project-1'); // whatever went out, went where it was typed
        }
    });

    it('flushes unsent edits on the way out instead of dropping them', async () => {
        const { api, sent } = conditionalSave('T0');
        const { rerender } = render(<Harness api={api} opened={asDraft('T0')} projectId="project-1" />);

        click('edit');
        expect(sent).toHaveLength(0);
        rerender(<Harness api={api} opened={asDraft('S0')} projectId="project-2" />);
        await settle();

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ projectId: 'project-1', value: '2k' });
    });
});

describe('leaving the page', () => {
    it('sends the last edit rather than dropping it with the debounce', async () => {
        const { api, sent } = conditionalSave('T0');
        const { unmount } = render(<Harness api={api} opened={asDraft('T0')} />);

        click('edit');
        expect(sent).toHaveLength(0); // still inside the debounce window

        await act(async () => {
            unmount();
            await Promise.resolve();
        });
        expect(sent).toEqual([{ projectId: 'project-1', value: '2k', token: 'T0', baseVersionId: undefined }]);
    });
});
