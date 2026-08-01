/**
 * @jest-environment jsdom
 */
/**
 * The hook, under the switch that made it lie.
 *
 * `useAsync` aborts a superseded request, which stops a LATE WRITE. It did nothing about the value already in
 * state — and that gap is not cosmetic. Switching to an organisation with no projects disabled the hook, the
 * effect returned early, and the pane went on rendering the PREVIOUS project's document under the new
 * organisation's name: its object tree, its "Draft · saved <timestamp>", its component counts. No spinner, no
 * error, nothing loading. It looked like a settled, correct screen, and it stayed that way.
 *
 * Today the studio is read-only, so that misleads rather than corrupts. The moment a save path reads the
 * document on screen, it is the bug that writes into the wrong project — which is why it is tested now,
 * before that path exists rather than after.
 *
 * A jsdom environment via the pragma above, so this one file gets a DOM without splitting the whole config.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { useAsync } from './useAsync';

/** A probe that renders whatever the hook currently holds, so assertions read the real render output. */
function Probe({ answers }: { answers: Record<string, string> }) {
    const [key, setKey] = useState('a');
    const [enabled, setEnabled] = useState(true);
    const state = useAsync(() => Promise.resolve(answers[key] ?? 'missing'), [key, answers], enabled);

    return (
        <div>
            <output data-testid="data">{state.data ?? '—'}</output>
            <output data-testid="loading">{String(state.loading)}</output>
            <button onClick={() => setKey('b')}>switch</button>
            <button onClick={() => setEnabled(false)}>disable</button>
            <button onClick={state.reload}>reload</button>
        </div>
    );
}

const value = () => screen.getByTestId('data').textContent;

describe('useAsync does not answer the new question with the old answer', () => {
    const answers = { a: 'A-document', b: 'B-document' };

    it('replaces the previous key’s data rather than leaving it on screen', async () => {
        render(<Probe answers={answers} />);
        await waitFor(() => expect(value()).toBe('A-document'));

        act(() => screen.getByText('switch').click());
        // The instant the key changes, the old document must be gone — not still showing until B arrives.
        expect(value()).toBe('—');
        await waitFor(() => expect(value()).toBe('B-document'));
    });

    it('clears the data when the hook is DISABLED — the case that was permanent', async () => {
        // The early return skipped every reset, so a disabled hook kept rendering the last thing it fetched
        // forever. This is the organisation-with-no-projects screen, and the live database says that shape is
        // the majority: a project-less personal workspace org is created for every account at registration.
        render(<Probe answers={answers} />);
        await waitFor(() => expect(value()).toBe('A-document'));

        act(() => screen.getByText('disable').click());
        expect(value()).toBe('—');
        expect(screen.getByTestId('loading').textContent).toBe('false'); // settled, not stuck loading
    });

    it('does NOT blank the pane on a manual reload — same question, same answer', async () => {
        // The other half of the rule. Clearing on every effect run would make `reload()` flash the panel
        // empty, which is the opposite complaint and just as wrong.
        render(<Probe answers={answers} />);
        await waitFor(() => expect(value()).toBe('A-document'));

        act(() => screen.getByText('reload').click());
        expect(value()).toBe('A-document');
        await waitFor(() => expect(value()).toBe('A-document'));
    });
});
