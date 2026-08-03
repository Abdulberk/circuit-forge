/**
 * @jest-environment jsdom
 */
/**
 * The store that holds work the server does not have yet.
 *
 * Two properties carry the whole module and both are about honesty rather than storage: a write that did
 * not happen must SAY it did not happen, and a half-written entry must read as no draft rather than as a
 * draft that explodes when someone tries to restore it.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';

import { browserDraftStore, memoryDraftStore, type StoredDraft } from './draftStore';

const CIRCUIT = {
    version: '1.0',
    components: [{ id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [] }],
    nets: [{ id: 'n1', name: 'N1' }],
} as unknown as CircuitJson;

const draft = (over: Partial<StoredDraft> = {}): StoredDraft => ({
    projectId: 'p1',
    circuit: CIRCUIT,
    // A real arrangement, not `{}`. Dragging symbols into a readable layout is work that exists nowhere in
    // the netlist, so a rescue buffer that held the components and lost their positions would hand back a
    // document that is correct and looks scrambled — the kind of loss nothing announces.
    ui: { schemaVersion: 1, positions: { r1: { x: 100, y: 40, rotation: '90' } } },
    baseToken: 'T0',
    baseVersionId: null,
    at: '2026-08-02T10:00:00.000Z',
    ...over,
});

beforeEach(() => window.localStorage.clear());

describe('keeping a draft on this device', () => {
    it('round-trips a draft with everything needed to judge it later', () => {
        const store = browserDraftStore();
        expect(store.put(draft())).toEqual({ ok: true });
        // The token especially: without it, "unsaved work from your last session" and "work built on a
        // draft someone has since replaced" are indistinguishable, and they deserve different words.
        expect(store.get('p1')).toEqual(draft());
    });

    it('keeps projects apart', () => {
        const store = browserDraftStore();
        store.put(draft({ projectId: 'p1' }));
        store.put(draft({ projectId: 'p2', at: '2026-08-02T11:00:00.000Z' }));
        expect(store.get('p1')?.at).toBe('2026-08-02T10:00:00.000Z');
        expect(store.get('p2')?.at).toBe('2026-08-02T11:00:00.000Z');
        expect(store.list().map((d) => d.projectId)).toEqual(['p2', 'p1']); // newest first
    });

    it('clears one project without touching the others', () => {
        const store = browserDraftStore();
        store.put(draft({ projectId: 'p1' }));
        store.put(draft({ projectId: 'p2' }));
        store.clear('p1');
        expect(store.get('p1')).toBeNull();
        expect(store.get('p2')).not.toBeNull();
    });

    it('reads a corrupt entry as NO draft rather than as one that breaks on restore', () => {
        window.localStorage.setItem('circuit-forge.draft.p1', '{"projectId":"p1","circu');
        expect(browserDraftStore().get('p1')).toBeNull();
        window.localStorage.setItem('circuit-forge.draft.p2', JSON.stringify({ projectId: 'p2', at: 'x' }));
        expect(browserDraftStore().get('p2')).toBeNull(); // no circuit at all
    });

    it('accepts a HALF-FINISHED circuit — that is what a draft is', () => {
        // The shape check is deliberately about components and nets being arrays, not the full schema. A
        // draft is by nature incomplete, and validating it as a finished circuit would refuse exactly the
        // work most worth recovering.
        const store = browserDraftStore();
        const midEdit = { version: '1.0', components: [{ id: 'r9' }], nets: [] } as unknown as CircuitJson;
        expect(store.put(draft({ circuit: midEdit })).ok).toBe(true);
        expect(store.get('p1')?.circuit).toEqual(midEdit);
    });

    it('still recovers an entry written before drawings were kept', () => {
        // Real entries from the previous build of this store are sitting in real users' browsers with no
        // `ui` key at all. Reading one as a broken draft would throw away the circuit it holds because of a
        // field that did not exist when it was written — losing work over an upgrade, which is the one
        // thing a recovery buffer must never do.
        const legacy = { ...draft() } as Partial<StoredDraft>;
        delete legacy.ui;
        window.localStorage.setItem('circuit-forge.draft.p1', JSON.stringify(legacy));

        const found = browserDraftStore().get('p1');
        expect(found?.circuit).toEqual(CIRCUIT);
        // No drawing means no drawing, not a crash and not `undefined` — the same value a project nobody
        // has arranged yet produces, so one branch downstream covers both.
        expect(found?.ui).toEqual({});
    });

    it('refuses a drawing that is not an object, rather than handing a reader something that breaks it', () => {
        // A hand-edited or truncated entry. `ui` reaching the canvas as a string or an array is a crash on
        // the first property read, and the circuit beside it is still perfectly recoverable.
        window.localStorage.setItem(
            'circuit-forge.draft.p1',
            JSON.stringify({ ...draft(), ui: ['positions', 'r1'] }),
        );
        expect(browserDraftStore().get('p1')?.ui).toEqual({});
    });

    it('ignores unrelated localStorage keys when listing', () => {
        window.localStorage.setItem('circuit-forge.session', '{"accessToken":"a","refreshToken":"b"}');
        browserDraftStore().put(draft());
        expect(browserDraftStore().list()).toHaveLength(1);
    });
});

describe('when the browser will not keep it', () => {
    it('REPORTS a refused write instead of returning silently', () => {
        // The property the whole module exists for. A user who believes their work is backed up when it is
        // not will make different decisions than one who knows.
        const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('exceeded', 'QuotaExceededError');
        });
        try {
            expect(browserDraftStore().put(draft())).toMatchObject({ ok: false, reason: 'quota' });
        } finally {
            setItem.mockRestore();
        }
    });

    it('sacrifices OTHER projects’ drafts to make room for the one being edited', () => {
        // The work in front of the user is worth more than a stale copy of a project they closed. Keeping
        // the old one and refusing the new one is the wrong trade.
        const store = browserDraftStore();
        store.put(draft({ projectId: 'old' }));

        let calls = 0;
        const real = Storage.prototype.setItem;
        const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
            this: Storage,
            k: string,
            v: string,
        ) {
            if (++calls === 1) throw new DOMException('exceeded', 'QuotaExceededError');
            real.call(this, k, v);
        });
        try {
            expect(store.put(draft({ projectId: 'p1' }))).toEqual({ ok: true });
            expect(store.get('p1')).not.toBeNull();
            expect(store.get('old')).toBeNull(); // evicted to make room
        } finally {
            setItem.mockRestore();
        }
    });
});

describe('the memory store keeps the same contract', () => {
    it('behaves like the browser one, so a test that passes here means something', () => {
        const store = memoryDraftStore([draft({ projectId: 'seeded' })]);
        expect(store.get('seeded')).not.toBeNull();
        expect(store.put(draft({ projectId: 'p1' }))).toEqual({ ok: true });
        store.clear('seeded');
        expect(store.list().map((d) => d.projectId)).toEqual(['p1']);
    });
});
