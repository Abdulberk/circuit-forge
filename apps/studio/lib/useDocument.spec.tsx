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
import type { CircuitJson, UiJson } from '@circuit-forge/eda-core';
import { connectPins, setValue } from '@circuit-forge/editor-core';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { ApiError, type Api, type OpenedProject } from './api';
import { memoryDraftStore, refusingDraftStore, type DraftStore, type StoredDraft } from './draftStore';
import { useDocument } from './useDocument';

const CIRCUIT: CircuitJson = {
    version: '1.0',
    // Two parts on two nets, so a MERGE is expressible. `r1` stays components[0], which every existing
    // assertion in this file reads through.
    components: [
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'n1' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '2k', pins: [{ pinId: '1', netId: 'n2' }] },
    ],
    nets: [
        { id: 'n1', name: 'N1' },
        { id: 'n2', name: 'N2' },
    ],
};

const asDraft = (updatedAt: string, baseVersionId: string | null = null, uiJson: UiJson = {}): OpenedProject => ({
    source: 'working-copy',
    circuitJson: CIRCUIT,
    uiJson,
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
    /**
     * The DRAWING that went with each save, recorded separately from `sent`.
     *
     * Separately because the assertions on `sent` are about which circuit went with which token, and
     * folding a positions map into every one of them would bury that in noise. It is still recorded on
     * EVERY call, never only when a test asks: the whole failure being guarded against here is a save that
     * carries a circuit and silently blanks the arrangement, and that is only visible if the blank is
     * captured too.
     */
    const sentUi: UiJson[] = [];
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
                uiJson: UiJson;
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
            sentUi.push(body.uiJson);
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

    return { api, sent, sentUi, somebodyElseSaves, currentToken: () => current };
}

/** Put R1 at a point, leaving the rest of the drawing alone — what a drag-release produces. */
const withR1 = (ui: UiJson, x: number, y: number): UiJson => ({
    ...ui,
    schemaVersion: 1,
    positions: { ...ui.positions, r1: { x, y } },
});

function Harness({
    api,
    opened,
    projectId = 'project-1',
    onReload,
    store,
}: {
    api: Api;
    opened: OpenedProject;
    projectId?: string;
    onReload?: () => void;
    store?: DraftStore;
}) {
    const [n, setN] = useState(0);
    const doc = useDocument(api, projectId, opened, onReload ?? (() => {}), store ?? memoryDraftStore());
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

            <output data-testid="notes">{doc.notes.join(' | ') || '—'}</output>
            <button
                onClick={() =>
                    doc.apply((c) =>
                        connectPins(c, { componentId: 'r2', pinId: '1' }, { componentId: 'r1', pinId: '1' }),
                    )
                }
            >
                connect
            </button>
            <button
                onClick={() =>
                    doc.apply((c) =>
                        connectPins(c, { componentId: 'r1', pinId: '1' }, { componentId: 'r1', pinId: '1' }),
                    )
                }
            >
                connect-self
            </button>

            {/* The drawing, driven the way the canvas will drive it: derive the next one from the current
                one and hand the whole thing back. `at` is a parameter so a test can move a symbol TO where
                it already is, which must not mint a revision. */}
            <output data-testid="ui">{JSON.stringify(doc.ui)}</output>
            <button onClick={() => doc.commitUi('Move R1', withR1(doc.ui, 100, 40))}>move</button>
            <button onClick={() => doc.commitUi('Move R1', withR1(doc.ui, 300, 40))}>move-again</button>

            <output data-testid="recovery">
                {doc.recovery ? `${doc.recovery.at}/${doc.recovery.continuesServerDraft}` : '—'}
            </output>
            <output data-testid="recovered-value">{(doc.recovery?.circuit.components ?? [])[0]?.value ?? '—'}</output>
            <output data-testid="recovered-ui">{JSON.stringify(doc.recovery?.ui ?? null)}</output>
            <output data-testid="backup">{doc.localBackup.ok ? 'ok' : doc.localBackup.reason}</output>
            <button onClick={doc.recoverLocal}>recover</button>
            <button onClick={doc.discardLocal}>discard-local</button>
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

/**
 * The copy that survives the tab.
 *
 * What is actually at risk: an edit is instant and a save is not, so everything typed between a keystroke
 * and the 1.2 s idle save exists only in memory. A crashed tab, a closed laptop, or a save the server keeps
 * refusing, and it is gone. These tests are about that gap — and, just as much, about the local copy NOT
 * becoming a second authority, which is how a safety net turns into a hazard.
 */
const recovery = () => screen.getByTestId('recovery').textContent;
const backup = () => screen.getByTestId('backup').textContent;

const storedDraft = (over: Partial<StoredDraft> = {}): StoredDraft => ({
    projectId: 'project-1',
    circuit: { ...CIRCUIT, components: [{ ...CIRCUIT.components[0]!, value: '99k' }] },
    baseToken: 'T0',
    baseVersionId: null,
    at: '2026-08-02T10:00:00.000Z',
    ...over,
});

describe('the drawing is part of the document', () => {
    // Every test here fails against the build that shipped before this one, and that build was not missing
    // a feature — it was actively destroying data. `uiJson: {}` was hard-coded into the save, `ui: {}` into
    // the open, and `commitUi` had no caller outside its own unit test. So the drawing could not be sent,
    // could not be read back, and the one function that could have changed it was unreachable.

    const arrangement: UiJson = {
        schemaVersion: 1,
        positions: { r1: { x: 20, y: 20, rotation: '90' }, r2: { x: 120, y: 20 } },
    };

    it('SENDS the arrangement, not an empty one', async () => {
        const { api, sentUi } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        click('move');
        await settle();

        await waitFor(() => expect(sentUi).toHaveLength(1));
        expect(sentUi[0]!.positions).toEqual({ r1: { x: 100, y: 40 } });
    });

    it('READS the arrangement back when the project opens', () => {
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0', null, arrangement)} />);
        expect(JSON.parse(screen.getByTestId('ui').textContent!)).toEqual(arrangement);
    });

    it('does not WIPE the arrangement when the circuit is edited', async () => {
        // The bug in its exact shape. Arrange the sheet, then type one character: the autosave that follows
        // carried a hard-coded empty drawing, so the positions were gone from the server 1.2 s later while
        // still on screen. The user would only find out on the next reload.
        const { api, sent, sentUi } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0', null, arrangement)} />);

        click('edit');
        await settle();

        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]!.value).toBe('2k'); // the edit really went
        expect(sentUi[0]).toEqual(arrangement); // …and took the arrangement with it
    });

    it('does not wipe the CIRCUIT when the arrangement changes either', async () => {
        // The same failure mirrored. A drag saves the whole document, so a version of this that sent only
        // the drawing would push the netlist back to whatever the last circuit save happened to hold.
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        click('edit');
        click('move');
        await settle();

        await waitFor(() => expect(status()).toBe('clean'));
        expect(sent[sent.length - 1]!.value).toBe('2k');
    });

    it('UNDOES a move, and the undone arrangement is what gets saved', async () => {
        // Undo has to cover the drawing or Ctrl+Z becomes conditional on what kind of thing you did last,
        // which is not something a user can hold in their head.
        const { api, sentUi } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        click('move');
        await settle();
        click('move-again');
        await settle();
        expect(sentUi[sentUi.length - 1]!.positions).toEqual({ r1: { x: 300, y: 40 } });

        click('undo');
        await settle();
        expect(JSON.parse(screen.getByTestId('ui').textContent!).positions).toEqual({ r1: { x: 100, y: 40 } });
        expect(sentUi[sentUi.length - 1]!.positions).toEqual({ r1: { x: 100, y: 40 } });
    });

    it('a move that ends where it started is not a revision and not a save', async () => {
        // A drag that returns to the origin, a rotate pressed four times. Minting a revision for it would
        // put a step in the undo stack that visibly does nothing, and minting a save would bump the
        // concurrency token — so another tab's real work would 409 against a gesture that changed nothing.
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} />);

        click('move');
        await settle();
        const after = sent.length;
        expect(screen.getByTestId('canUndo').textContent).toBe('true');

        click('move'); // same coordinates again
        await settle();

        expect(sent).toHaveLength(after);
        expect(status()).toBe('clean');
        click('undo');
        // One undo is enough to get back to no arrangement at all — proof the second click minted nothing.
        expect(JSON.parse(screen.getByTestId('ui').textContent!)).toEqual({});
    });

    it('keeps the arrangement in the copy held on THIS device', async () => {
        // A crash between the drag and the save must not hand back a document that is correct and looks
        // scrambled, which is a loss nothing announces.
        const { api } = conditionalSave('T0');
        const store = memoryDraftStore();
        render(<Harness api={api} opened={asDraft('T0')} store={store} />);

        click('move');
        await act(async () => {
            jest.advanceTimersByTime(300); // past the local write, short of the save
            await Promise.resolve();
        });

        expect(store.get('project-1')?.ui).toEqual({ schemaVersion: 1, positions: { r1: { x: 100, y: 40 } } });
    });

    it('OFFERS a local copy whose only unsaved change is the arrangement', () => {
        // The comparison that decides "nothing to rescue" used to look at the netlist alone. A session
        // spent dragging twenty symbols changes no component and no net, so that copy was deleted on open
        // as a duplicate — silently discarding the entire session's work.
        const { api } = conditionalSave('T0');
        const store = memoryDraftStore([
            {
                projectId: 'project-1',
                circuit: CIRCUIT, // byte-identical to the server's
                ui: arrangement, // …and this is the whole difference
                baseToken: 'T0',
                baseVersionId: null,
                at: '2026-08-02T10:00:00.000Z',
            },
        ]);
        render(<Harness api={api} opened={asDraft('T0')} store={store} />);

        expect(screen.getByTestId('recovery').textContent).toBe('2026-08-02T10:00:00.000Z/true');
        expect(JSON.parse(screen.getByTestId('recovered-ui').textContent!)).toEqual(arrangement);
    });

    it('does NOT offer a local copy that only differs in key order', async () => {
        // Both values here come out of Postgres `jsonb` columns, which do not preserve the key order they
        // were given — a drawing saved as {schemaVersion, positions, sheetId} comes back as {sheetId,
        // positions, schemaVersion}. A stringify comparison calls those different, so the "the server
        // already has exactly this" branch could never fire and every single open would announce unsaved
        // work that does not exist, which the user then has to make a decision about.
        const { api } = conditionalSave('T0');
        const reordered: UiJson = {
            positions: { r2: { x: 120, y: 20 }, r1: { y: 20, x: 20, rotation: '90' } },
            schemaVersion: 1,
        };
        const store = memoryDraftStore([
            {
                projectId: 'project-1',
                circuit: CIRCUIT,
                ui: reordered,
                baseToken: 'T0',
                baseVersionId: null,
                at: '2026-08-02T10:00:00.000Z',
            },
        ]);
        render(<Harness api={api} opened={asDraft('T0', null, arrangement)} store={store} />);

        expect(screen.getByTestId('recovery').textContent).toBe('—');
        expect(store.get('project-1')).toBeNull(); // …and the duplicate was cleared, not left to re-offer
    });

    it('restores the arrangement when that copy is recovered', async () => {
        const { api, sentUi } = conditionalSave('T0');
        const store = memoryDraftStore([
            {
                projectId: 'project-1',
                circuit: CIRCUIT,
                ui: arrangement,
                baseToken: 'T0',
                baseVersionId: null,
                at: '2026-08-02T10:00:00.000Z',
            },
        ]);
        render(<Harness api={api} opened={asDraft('T0')} store={store} />);

        click('recover');
        expect(JSON.parse(screen.getByTestId('ui').textContent!)).toEqual(arrangement);

        // Recovered work is not allowed to live on the device — it is scheduled like any edit so it reaches
        // the server, arrangement included.
        await settle();
        await waitFor(() => expect(sentUi).toHaveLength(1));
        expect(sentUi[0]).toEqual(arrangement);
    });

    it('does not save the VIEWPORT, so scrolling cannot conflict with someone else’s work', async () => {
        // Where a person has scrolled is a property of the person, not the board. Writing it would make
        // merely looking at a project a write that bumps the concurrency token, and a second tab doing
        // nothing but panning would 409 the first tab's real edits.
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0', null, arrangement)} />);

        await settle();
        expect(sent).toHaveLength(0); // opening and looking is not a write
    });
});

describe('unsaved work survives the tab', () => {
    it('writes the document to this device WITHOUT waiting for the save', async () => {
        // The whole point: the local copy must hold what the server does not have yet. Waiting for the save
        // would leave nothing behind exactly when the save is what failed.
        const store = memoryDraftStore();
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={store} />);

        click('edit');
        expect(store.get('project-1')).toBeNull(); // coalesced, not yet written

        await act(async () => {
            jest.advanceTimersByTime(300); // past the local timer, well short of the 1.2 s save
            await Promise.resolve();
        });
        expect(store.get('project-1')?.circuit.components[0]?.value).toBe('2k');
        expect(status()).toBe('dirty'); // …and the server still has nothing
    });

    it('keeps the local copy while a save keeps FAILING — the case it exists for', async () => {
        const store = memoryDraftStore();
        const api = {
            saveWorkingCopy: () => Promise.reject(new ApiError('network', 'offline')),
        } as unknown as Api;
        render(<Harness api={api} opened={asDraft('T0')} store={store} />);

        click('edit');
        await settle();
        expect(status()).toBe('error');
        expect(store.get('project-1')?.circuit.components[0]?.value).toBe('2k');
    });

    it('clears the local copy once the server actually has the work', async () => {
        // Not before. A copy kept past a successful save would be offered back on the next open as if it
        // were newer, and the user would be invited to undo their own saved progress.
        const store = memoryDraftStore();
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={store} />);

        click('edit');
        await settle();
        await waitFor(() => expect(status()).toBe('clean'));
        expect(store.get('project-1')).toBeNull();
    });

    it('SAYS SO when the browser will not keep anything, instead of pretending', async () => {
        // A user who believes their work is backed up when it is not makes different decisions than one who
        // knows. Silence here is the lie.
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={refusingDraftStore('quota')} />);
        expect(backup()).toBe('ok'); // nothing attempted yet

        click('edit');
        await act(async () => {
            jest.advanceTimersByTime(300);
            await Promise.resolve();
        });
        expect(backup()).toBe('quota');
    });
});

describe('recovered work is OFFERED, never applied', () => {
    it('offers unsaved work typed on top of what the server still holds', async () => {
        const store = memoryDraftStore([storedDraft({ baseToken: 'T0' })]);
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={store} />);

        // The document on screen is the SERVER's, untouched. Restoring silently is how a tab overwrites a
        // colleague's saved work while looking like it rescued yours.
        expect(value()).toBe('1k');
        expect(recovery()).toBe('2026-08-02T10:00:00.000Z/true');
        expect(screen.getByTestId('recovered-value').textContent).toBe('99k');
    });

    it('distinguishes work built on a draft the server has since REPLACED', async () => {
        // Same rescue, different confidence — and the wording downstream depends on it.
        const store = memoryDraftStore([storedDraft({ baseToken: 'OLD', at: '2999-01-01T00:00:00.000Z' })]);
        const { api } = conditionalSave('T5');
        render(<Harness api={api} opened={asDraft('T5')} store={store} />);
        expect(recovery()).toBe('2999-01-01T00:00:00.000Z/false');
    });

    it('drops a copy the server ALREADY HAS rather than offering it back', async () => {
        // Decidable from the documents themselves. The earlier version of this rule compared the local
        // write time against the server's updatedAt — two clocks on two machines — and a client running a
        // day behind would have silently deleted real unsaved work.
        const store = memoryDraftStore([storedDraft({ baseToken: 'OLD', circuit: CIRCUIT })]);
        const { api } = conditionalSave('T9');
        render(<Harness api={api} opened={asDraft('T9')} store={store} />);
        expect(recovery()).toBe('—');
        expect(store.get('project-1')).toBeNull();
    });

    it('OFFERS work built on a replaced draft rather than dropping it — erring toward the work', async () => {
        // Erring toward offering costs a dialog; erring the other way costs the work.
        const store = memoryDraftStore([storedDraft({ baseToken: 'OLD', at: '2020-01-01T00:00:00.000Z' })]);
        const { api } = conditionalSave('T9');
        render(<Harness api={api} opened={asDraft('T9')} store={store} />);
        expect(recovery()).toBe('2020-01-01T00:00:00.000Z/false');
    });

    it('adopting puts it on screen AND sends it — the buffer is not a place work may live', async () => {
        const store = memoryDraftStore([storedDraft({ baseToken: 'T0' })]);
        const { api, sent } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={store} />);

        click('recover');
        expect(value()).toBe('99k');
        expect(recovery()).toBe('—');

        await settle();
        await waitFor(() => expect(status()).toBe('clean'));
        expect(sent.at(-1)?.value).toBe('99k');
    });

    it('adopting is ADOPT, not commit — undo must not step into a session this tab never saw', async () => {
        const store = memoryDraftStore([storedDraft({ baseToken: 'T0' })]);
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={store} />);

        click('recover');
        expect(screen.getByTestId('canUndo').textContent).toBe('false');
    });

    it('discarding removes it for good and does not write it straight back', async () => {
        // The coalescing timer is the trap: a discard that left a queued write pending would restore the
        // copy a quarter of a second later.
        const store = memoryDraftStore([storedDraft({ baseToken: 'T0' })]);
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={store} />);

        click('discard-local');
        expect(recovery()).toBe('—');
        expect(store.get('project-1')).toBeNull();

        await settle();
        expect(store.get('project-1')).toBeNull();
    });

    it('offers a local draft for a project the server has NOTHING for', async () => {
        // A project created and typed into but never successfully saved: the server has no draft and no
        // version, so the local copy is the only place that work exists anywhere.
        const store = memoryDraftStore([storedDraft({ baseToken: null })]);
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={{ source: 'empty' }} store={store} />);
        expect(recovery()).toBe('2026-08-02T10:00:00.000Z/true');
        expect(screen.getByTestId('recovered-value').textContent).toBe('99k');
    });
    it('offers nothing when this device holds no unsaved work', async () => {
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={memoryDraftStore()} />);
        expect(recovery()).toBe('—');
    });
});

/**
 * The edit that costs something.
 *
 * A refusal stops an edit; a note accompanies one that went through and destroyed something on the way.
 * Connectivity is where that happens: joining two nets leaves one name where there were two. These tests
 * exist because the whole chain — kernel → commit → hook → screen — has to carry the sentence, and a break
 * anywhere in it is silent by construction.
 */
const notes = () => screen.getByTestId('notes').textContent;

describe('an edit that destroys something says so', () => {
    it('carries a merge note from the kernel all the way to the hook', async () => {
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={memoryDraftStore()} />);

        click('connect');
        expect(notes()).toBe('N2 merged into N1.');
    });

    it('REPLACES the note on the next edit rather than accumulating', async () => {
        // A growing list would leave the user reading about a merge they made ten edits ago.
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={memoryDraftStore()} />);

        click('connect');
        expect(notes()).not.toBe('—');
        click('edit'); // an ordinary value change, which costs nothing
        expect(notes()).toBe('—');
    });

    it('shows nothing for an edit that destroys nothing', async () => {
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={memoryDraftStore()} />);
        click('edit');
        expect(notes()).toBe('—');
    });

    it('a refused connection produces a refusal and NO note', async () => {
        // The two are different answers and must not both appear: the edit did not happen, so nothing
        // was destroyed.
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={memoryDraftStore()} />);
        click('connect-self');
        expect(screen.getByTestId('refusal').textContent).toBe('no-such-pin');
        expect(notes()).toBe('—');
    });

    it('does not leave the LAST edit’s note standing under a refusal', () => {
        // The two banners sit next to each other on the page, so a note left over reads as a description of
        // the edit that did NOT happen — "that would short GND to VCC" with "N2 merged into N1." directly
        // beneath it. The test above starts from a clean state and so passed without any clearing at all;
        // the defect only appears in the SEQUENCE.
        const { api } = conditionalSave('T0');
        render(<Harness api={api} opened={asDraft('T0')} store={memoryDraftStore()} />);

        click('connect');
        expect(notes()).toBe('N2 merged into N1.');
        click('connect-self');
        expect(screen.getByTestId('refusal').textContent).toBe('no-such-pin');
        expect(notes()).toBe('—');
    });
});
