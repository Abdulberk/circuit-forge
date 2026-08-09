/**
 * What the rule check found, listed beside the drawing that carries the marks.
 *
 * A mark on the sheet says WHERE and this says WHAT, and clicking a line selects what it names — which is the
 * whole reason to have both: nobody should have to hunt a four-hundred-part sheet for the part an error
 * mentions.
 *
 * The panel's real job is to be worth reading. That is a design constraint, not a nicety: a checker that
 * reports everything at one pitch gets ignored, and an ignored checker is worse than none, because the sheet
 * still looks checked. So the three severities are counted apart, the border follows the WORST thing present
 * rather than "anything at all", and a line that names nothing leaves the selection alone.
 */

import type { ErcIssue, CircuitJson } from '@circuit-forge/eda-core';
import { buildObjectTree, componentPath, netPath, type TreeNode } from '@circuit-forge/editor-core';

/** How many lines are listed before the rest are summarised. A panel is a summary, not a report. */
const SHOWN = 12;

/** "1 error", "2 errors", "0 notes" — a count that reads like a sentence rather than a field. */
const counted = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

export interface ErcNoticeProps {
    problems: readonly ErcIssue[];
    /** The document the ids are resolved against; without it a line cannot select anything. */
    circuit: CircuitJson | null;
    onSelect?: (nodes: TreeNode[]) => void;
}

export function ErcNotice({ problems, circuit, onSelect }: ErcNoticeProps): React.JSX.Element | null {
    if (problems.length === 0) return null;

    const errors = problems.filter((p) => p.severity === 'error').length;
    const warnings = problems.filter((p) => p.severity === 'warning').length;
    const notes = problems.filter((p) => p.severity === 'info').length;

    // THE WORST THING PRESENT decides the colour. Reading "anything that is not an error" as a warning
    // painted the box amber for a sheet whose only remarks were advisory — and a half-wired sheet is full of
    // those, so the panel spent the entire middle of a design crying wolf.
    const tone = errors > 0 ? 'bad' : warnings > 0 ? 'warn' : 'info';

    /**
     * WORST FIRST, then as they came.
     *
     * The list is truncated, and it used to truncate in CHECK order — which is the order `runErc` happens to
     * run its checks in, not an order that means anything to a reader. Measured on a real sheet with six
     * unwired parts on it: the panel said "1 error", painted itself red, listed twelve dead-end-net warnings
     * and "…and 7 more", and the error was not among them. So the one thing saying the sheet cannot be built
     * was counted, coloured, and never shown — and the click-to-select path, which is the whole reason the
     * panel exists, did not exist for exactly the issue that mattered most.
     *
     * A stable sort: within a severity the order is still the checker's, because that order groups related
     * remarks together and a reader following the list down expects it to stay put.
     */
    const RANK = { error: 0, warning: 1, info: 2 } as const;
    const ordered = [...problems].sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3));

    return (
        <div className={`notice ${tone}`} data-testid="erc-notice">
            <h4>
                {/* COUNTED APART, because they mean different things: an error is a sheet that cannot be
                    built, a warning is one that probably should not be, and a note is an observation. Lumping
                    the last two together turned twenty nets nobody had got to yet into "0 errors · 20
                    warnings", which is how a panel teaches people to stop reading it. */}
                {counted(errors, 'error')}
                {' · '}
                {counted(warnings, 'warning')}
                {' · '}
                {counted(notes, 'note')}
            </h4>
            <ul>
                {ordered.slice(0, SHOWN).map((issue, i) => (
                    <li key={`${issue.code}:${issue.relatedIds.join(',')}:${i}`}>
                        <button
                            type="button"
                            data-testid={`erc-${issue.code}`}
                            data-severity={issue.severity}
                            style={{ textAlign: 'left' }}
                            onClick={() => {
                                if (!circuit || !onSelect) return;
                                const { byPath } = buildObjectTree(circuit);
                                // ASKED, not guessed. The issue now says what each id names, so a remark
                                // about a net called `r1` selects that net rather than the resistor that
                                // happens to share the string. Where an older issue does not say — the field
                                // is optional so a hand-built one is still valid — both addresses are tried
                                // and whatever exists is selected, which is what this always did.
                                const found = (
                                    issue.related ?? issue.relatedIds.map((id) => ({ kind: undefined, id }))
                                ).flatMap(({ kind, id }) =>
                                    kind === 'component'
                                        ? (byPath.get(componentPath(id)) ?? [])
                                        : kind === 'net'
                                          ? (byPath.get(netPath(id)) ?? [])
                                          : (byPath.get(componentPath(id)) ?? byPath.get(netPath(id)) ?? []),
                                );
                                // ONLY IF IT NAMES SOMETHING. Some remarks are about the sheet rather than any
                                // object on it, and some name an id that has since been deleted. Clearing the
                                // selection in either case punishes a user for reading the panel: they lose
                                // the parts they had picked and get nothing back.
                                if (found.length > 0) onSelect(found);
                            }}
                        >
                            {issue.message}
                        </button>
                    </li>
                ))}
                {problems.length > SHOWN && <li>…and {problems.length - SHOWN} more</li>}
            </ul>
        </div>
    );
}
