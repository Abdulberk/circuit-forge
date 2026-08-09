/**
 * @jest-environment jsdom
 */
/**
 * Whether the panel is worth reading — which is the only property that matters about a checker's output.
 *
 * A checker that reports everything at one pitch gets ignored, and an ignored checker is worse than none,
 * because the sheet still looks checked. Both defects below are that failure: an advisory remark counted and
 * coloured as a warning, and a line that punished the user for clicking it.
 */

import type { CircuitJson, ErcIssue } from '@circuit-forge/eda-core';
import type { TreeNode } from '@circuit-forge/editor-core';
import { render, fireEvent } from '@testing-library/react';

import { ErcNotice } from './ErcNotice';

const CIRCUIT: CircuitJson = {
    version: '1.0',
    components: [
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'a' },
                { pinId: '2', netId: 'b' },
            ],
        },
    ] as never,
    nets: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
    ],
};

const issue = (severity: ErcIssue['severity'], code: string, relatedIds: string[] = []): ErcIssue =>
    ({ code, severity, message: `${code} happened`, relatedIds }) as unknown as ErcIssue;

const toneOf = (el: HTMLElement) => el.className.replace('notice', '').trim();

describe('the rule-check panel', () => {
    it('says nothing at all when there is nothing to say', () => {
        const { queryByTestId } = render(<ErcNotice problems={[]} circuit={CIRCUIT} />);
        expect(queryByTestId('erc-notice')).toBeNull();
    });

    describe('counting', () => {
        it('keeps notes APART from warnings', () => {
            // The defect. A half-wired sheet is full of advisory remarks — every net nobody has got to yet —
            // and counting them as warnings turned an ordinary work-in-progress into "0 errors · 20
            // warnings". A panel that alarms about normal work is a panel people stop reading.
            const { getByTestId } = render(
                <ErcNotice
                    problems={[issue('info', 'UNCONNECTED_NET'), issue('info', 'NON_STANDARD_VALUE')]}
                    circuit={CIRCUIT}
                />,
            );
            const heading = getByTestId('erc-notice').querySelector('h4')!;
            expect(heading.textContent).toContain('0 warnings');
            expect(heading.textContent).toContain('2 notes');
        });

        it('counts each severity as itself', () => {
            const { getByTestId } = render(
                <ErcNotice
                    problems={[issue('error', 'A'), issue('warning', 'B'), issue('warning', 'C'), issue('info', 'D')]}
                    circuit={CIRCUIT}
                />,
            );
            expect(getByTestId('erc-notice').querySelector('h4')!.textContent).toBe('1 error · 2 warnings · 1 note');
        });
    });

    describe('the border', () => {
        it('follows the WORST thing present, not merely the presence of anything', () => {
            const tone = (problems: ErcIssue[]) =>
                // Scoped to the render's OWN container: these four renders share one document, and a query
                // across the whole of it finds every box drawn so far rather than this one.
                toneOf(
                    render(<ErcNotice problems={problems} circuit={CIRCUIT} />).container.querySelector(
                        '[data-testid="erc-notice"]',
                    ) as HTMLElement,
                );
            expect(tone([issue('info', 'A')])).toBe('info');
            expect(tone([issue('info', 'A'), issue('warning', 'B')])).toBe('warn');
            expect(tone([issue('info', 'A'), issue('warning', 'B'), issue('error', 'C')])).toBe('bad');
            // And an error is still an error when it is outnumbered by notes.
            expect(tone([issue('info', 'A'), issue('info', 'B'), issue('error', 'C')])).toBe('bad');
        });
    });

    describe('clicking a line', () => {
        it('selects what it names', () => {
            // The whole reason the list is worth having: nobody should hunt a four-hundred-part sheet for
            // the part an error mentions.
            const seen: TreeNode[][] = [];
            const { getByTestId } = render(
                <ErcNotice problems={[issue('error', 'A', ['r1'])]} circuit={CIRCUIT} onSelect={(n) => seen.push(n)} />,
            );
            fireEvent.click(getByTestId('erc-A'));
            expect(seen).toHaveLength(1);
            expect(seen[0]!.map((n) => n.ref.id)).toEqual(['r1']);
        });

        it('resolves a NET as readily as a part, since the line does not say which', () => {
            const seen: TreeNode[][] = [];
            const { getByTestId } = render(
                <ErcNotice problems={[issue('info', 'A', ['b'])]} circuit={CIRCUIT} onSelect={(n) => seen.push(n)} />,
            );
            fireEvent.click(getByTestId('erc-A'));
            expect(seen[0]!.map((n) => n.ref.id)).toEqual(['b']);
        });

        it('selects the object the issue is ABOUT when a part and a net share an id', () => {
            // Trying both addresses and taking whichever exists picks the part every time, because parts are
            // tried first — so a remark about a spare net called `r1` opened the resistor R1 and showed a
            // reader nothing wrong with it. The issue now says which one it means.
            const collide: CircuitJson = {
                ...CIRCUIT,
                nets: [...(CIRCUIT.nets as never[]), { id: 'r1', name: 'SPARE' }],
            } as CircuitJson;
            const seen: TreeNode[][] = [];
            const about = { relatedIds: ['r1'], related: [{ kind: 'net' as const, id: 'r1' }] };
            const { getByTestId } = render(
                <ErcNotice
                    problems={[{ ...issue('warning', 'A'), ...about }]}
                    circuit={collide}
                    onSelect={(n) => seen.push(n)}
                />,
            );
            fireEvent.click(getByTestId('erc-A'));
            expect(seen[0]!.map((n) => n.ref.kind)).toEqual(['net']);
        });

        it('LEAVES THE SELECTION ALONE when it names nothing', () => {
            // The defect. Some remarks are about the sheet rather than any object on it, and some name an id
            // that has since been deleted. Reporting an empty selection cleared whatever the user had picked
            // — so reading the panel cost them their work and gave nothing back.
            const seen: TreeNode[][] = [];
            const { getByTestId } = render(
                <ErcNotice
                    problems={[issue('warning', 'NOBODY'), issue('warning', 'GONE', ['r404'])]}
                    circuit={CIRCUIT}
                    onSelect={(n) => seen.push(n)}
                />,
            );
            fireEvent.click(getByTestId('erc-NOBODY'));
            fireEvent.click(getByTestId('erc-GONE'));
            expect(seen).toEqual([]);
        });

        it('does not throw when there is no document to resolve against', () => {
            const { getByTestId } = render(<ErcNotice problems={[issue('error', 'A', ['r1'])]} circuit={null} />);
            expect(() => fireEvent.click(getByTestId('erc-A'))).not.toThrow();
        });
    });

    it('shows the WORST first, so a truncated list never hides an error', () => {
        // THE DEFECT. The list is truncated and it truncated in CHECK order — the order `runErc` happens to
        // run its checks in, which means nothing to a reader. Measured on a real sheet with six unwired parts
        // on it: the panel said "1 error", painted itself red, listed twelve dead-end-net warnings and
        // "…and 7 more", and the error was not among them. The one thing saying the sheet cannot be built was
        // counted, coloured, and never shown — and clicking it to find the part was impossible.
        const problems = [
            ...Array.from({ length: 14 }, (_, i) => issue('info', `N${i}`)),
            ...Array.from({ length: 6 }, (_, i) => issue('warning', `W${i}`)),
            issue('error', 'THE_ERROR', ['r1']),
        ];
        const { getByTestId } = render(<ErcNotice problems={problems} circuit={CIRCUIT} />);
        const panel = getByTestId('erc-notice');
        expect(panel.querySelector('[data-testid="erc-THE_ERROR"]')).not.toBeNull();
        // …and the warnings come before the notes, for the same reason.
        const shown = [...panel.querySelectorAll('button[data-severity]')].map((b) => b.getAttribute('data-severity'));
        expect(shown[0]).toBe('error');
        expect(shown.filter((s) => s === 'warning').length).toBeGreaterThan(0);
    });

    it('keeps the checker’s own order WITHIN a severity', () => {
        // Sorting by severity must be stable: the checker groups related remarks together and a reader
        // following the list down expects it to stay put.
        const problems = [issue('warning', 'B'), issue('warning', 'A'), issue('error', 'E')];
        const { getByTestId } = render(<ErcNotice problems={problems} circuit={CIRCUIT} />);
        const codes = [...getByTestId('erc-notice').querySelectorAll('button[data-testid]')].map((b) =>
            b.getAttribute('data-testid'),
        );
        expect(codes).toEqual(['erc-E', 'erc-B', 'erc-A']);
    });

    it('summarises the tail rather than listing four hundred lines', () => {
        const many = Array.from({ length: 20 }, (_, i) => issue('warning', `W${i}`));
        const { getByTestId } = render(<ErcNotice problems={many} circuit={CIRCUIT} />);
        const list = getByTestId('erc-notice').querySelector('ul')!;
        expect(list.querySelectorAll('button')).toHaveLength(12);
        expect(list.textContent).toContain('and 8 more');
        // The count in the heading is of EVERYTHING, not of what is shown — a panel that said "12 warnings"
        // while hiding eight would be lying about the sheet.
        expect(getByTestId('erc-notice').querySelector('h4')!.textContent).toContain('20 warnings');
    });
});
