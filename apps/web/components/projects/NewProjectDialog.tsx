'use client';

/**
 * Start a project: blank, or from one of the public templates.
 *
 * A template is copied into the new project's draft (`PUT /working-copy`) with an empty drawing; the editor
 * lays it out once on open and from then on the drawing is the user's.
 */
import { safeValidateCircuitJson, type CircuitJson } from '@circuit-forge/eda-core';
import { useEffect, useRef, useState } from 'react';

import { useSession } from '../../app/providers';
import { ApiError, type Template } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Input';

import { TemplateOption } from './TemplateOption';

const BLANK: CircuitJson = { version: '1.0', components: [], nets: [] };

export function NewProjectDialog({
    orgId,
    onClose,
    onCreated,
}: {
    orgId: string;
    onClose: () => void;
    onCreated: (projectId: string) => void;
}) {
    const { api } = useSession();
    const templates = useAsync((signal) => api.templates({ limit: 50 }, signal), []);
    const [name, setName] = useState('');
    const [from, setFrom] = useState<Template | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dialog = useRef<HTMLDialogElement | null>(null);

    // A real modal: focus is trapped, Esc closes, and the page behind is inert. Where `showModal` does not
    // exist (an old browser, jsdom) the dialog is simply opened in place, so it is still usable.
    useEffect(() => {
        const d = dialog.current;
        if (!d || d.open) return;
        if (typeof d.showModal === 'function') d.showModal();
        else d.setAttribute('open', '');
    }, []);

    const create = async (e: React.FormEvent): Promise<void> => {
        e.preventDefault();
        const circuit = from ? from.circuitJson : BLANK;
        // Validated before it is sent: a template that does not parse would create a project that cannot open.
        if (!safeValidateCircuitJson(circuit).success) {
            setError('That template is not a valid circuit and cannot be used.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const project = await api.createProject(orgId, {
                name: name.trim() || from?.name || 'Untitled circuit',
                ...(from?.description ? { description: from.description } : {}),
            });
            await api.saveWorkingCopy(project.id, { circuitJson: circuit, uiJson: {} });
            onCreated(project.id);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : String(err));
            setBusy(false);
        }
    };

    return (
        <dialog
            ref={dialog}
            onClose={onClose}
            aria-labelledby="new-project-title"
            className="m-auto w-full max-w-2xl rounded-xl border border-line bg-surface p-0 text-fg shadow-xl backdrop:bg-black/40"
        >
            <form
                onSubmit={(e) => {
                    void create(e);
                }}
                className="grid gap-5 p-6"
            >
                <div>
                    <h2 id="new-project-title" className="text-lg font-semibold">
                        New project
                    </h2>
                    <p className="mt-1 text-sm text-muted">Start from a blank sheet or from a ready-made circuit.</p>
                </div>

                <Field label="Name" htmlFor="project-name">
                    <Input
                        id="project-name"
                        autoFocus
                        placeholder={from?.name ?? 'Untitled circuit'}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={200}
                    />
                </Field>

                <fieldset>
                    <legend className="text-xs font-medium text-muted">Start from</legend>
                    <div role="radiogroup" className="mt-2 grid max-h-72 gap-2 overflow-auto pr-1 sm:grid-cols-2">
                        <TemplateOption
                            title="Blank sheet"
                            detail="An empty schematic."
                            selected={from === null}
                            onSelect={() => setFrom(null)}
                        />
                        {(templates.data ?? []).map((t) => (
                            <TemplateOption
                                key={t.id}
                                title={t.name}
                                detail={t.description ?? `${t.circuitJson.components.length} parts`}
                                tags={t.tags}
                                selected={from?.id === t.id}
                                onSelect={() => setFrom(t)}
                            />
                        ))}
                        {templates.loading && <p className="text-sm text-subtle">Loading templates…</p>}
                    </div>
                    {templates.error && (
                        <p className="mt-2 text-sm text-warn">
                            Templates could not be loaded; a blank project still works.
                        </p>
                    )}
                </fieldset>

                {error && <Alert tone="bad">{error}</Alert>}

                <div className="flex justify-end gap-2">
                    <Button
                        onClick={() =>
                            typeof dialog.current?.close === 'function' ? dialog.current.close() : onClose()
                        }
                    >
                        Cancel
                    </Button>
                    <Button type="submit" variant="primary" disabled={busy}>
                        {busy ? 'Creating…' : 'Create project'}
                    </Button>
                </div>
            </form>
        </dialog>
    );
}
