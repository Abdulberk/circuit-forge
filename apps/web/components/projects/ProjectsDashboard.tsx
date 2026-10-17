'use client';

/**
 * The projects page: every project in the active organisation, and the way to start a new one.
 *
 * Replaces the two dropdowns the studio used to choose an org and a project. A project opens at its own
 * URL, so it can be bookmarked, shared and reopened after a refresh.
 */
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { useSession } from '../../app/providers';
import { ApiError, type Project } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { AppHeader } from '../shell/AppHeader';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

import { NewProjectDialog } from './NewProjectDialog';
import { EmptyState, SkeletonGrid } from './parts';
import { ProjectGrid } from './ProjectGrid';
import { useActiveOrg } from './useActiveOrg';

const asApiError = (e: unknown): ApiError => (e instanceof ApiError ? e : new ApiError('unexpected', String(e)));

export function ProjectsDashboard() {
    const { api } = useSession();
    const router = useRouter();
    const { orgs, orgId, org, chooseOrg } = useActiveOrg();
    const projects = useAsync((signal) => api.projects(orgId!, { limit: 100 }, signal), [orgId], orgId !== null);
    const [query, setQuery] = useState('');
    const [creating, setCreating] = useState(false);
    const [actionError, setActionError] = useState<ApiError | null>(null);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        const all = [...(projects.data?.items ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (!q) return all;
        return all.filter((p) => p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q));
    }, [projects.data, query]);

    /** Run a project action; reload the list on success, show the failure otherwise. */
    const act = async (run: () => Promise<unknown>): Promise<void> => {
        setActionError(null);
        try {
            await run();
            projects.reload();
        } catch (e) {
            setActionError(asApiError(e));
        }
    };
    const rename = (p: Project): void => {
        const name = window.prompt('Rename project', p.name)?.trim();
        if (name && name !== p.name) void act(() => api.updateProject(p.id, { name }));
    };
    const remove = (p: Project): void => {
        if (window.confirm(`Delete “${p.name}”? Its drafts and saved versions are deleted too.`))
            void act(() => api.deleteProject(p.id));
    };

    return (
        <div className="flex min-h-screen flex-col bg-bg text-fg">
            <AppHeader>
                {(orgs.data?.length ?? 0) > 1 && (
                    <select
                        aria-label="Organisation"
                        value={orgId ?? ''}
                        onChange={(e) => chooseOrg(e.target.value)}
                        className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm"
                    >
                        {(orgs.data ?? []).map((o) => (
                            <option key={o.id} value={o.id}>
                                {o.name}
                            </option>
                        ))}
                    </select>
                )}
            </AppHeader>

            <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
                <div className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
                        <p className="mt-1 text-sm text-muted">{org?.name ?? ' '}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Input
                            type="search"
                            aria-label="Search projects"
                            placeholder="Search projects"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            className="w-64"
                        />
                        <Button variant="primary" onClick={() => setCreating(true)} disabled={!orgId}>
                            New project
                        </Button>
                    </div>
                </div>

                <div className="mt-6 grid gap-3 empty:hidden">
                    {orgs.error && (
                        <Alert tone="bad" title="Could not load your organisations">
                            {orgs.error.message}
                        </Alert>
                    )}
                    {projects.error && (
                        <Alert tone="bad" title="Could not load projects">
                            {projects.error.message}
                        </Alert>
                    )}
                    {actionError && (
                        <Alert tone="bad" title="That did not work">
                            {actionError.message}
                        </Alert>
                    )}
                </div>

                {(orgs.loading || projects.loading) && !projects.data && <SkeletonGrid />}
                {projects.data && shown.length === 0 && (
                    <EmptyState searching={query.trim() !== ''} onCreate={() => setCreating(true)} />
                )}
                {shown.length > 0 && <ProjectGrid projects={shown} onRename={rename} onDelete={remove} />}
                {projects.data?.hasMore && (
                    <p className="mt-4 text-sm text-subtle">
                        Showing the {projects.data.items.length} most recent of {projects.data.total} projects.
                    </p>
                )}
            </main>

            {creating && orgId && (
                <NewProjectDialog
                    orgId={orgId}
                    onClose={() => setCreating(false)}
                    onCreated={(id) => router.push(`/projects/${id}`)}
                />
            )}
        </div>
    );
}
