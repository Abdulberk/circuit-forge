/**
 * @jest-environment jsdom
 */
/**
 * The projects page against a fake API: listing, searching, creating from a template, deleting.
 *
 * The session is mocked at the provider boundary (one hook), not by stubbing fetch, so these tests are about
 * what the page does with answers — the API client has its own tests and a live contract suite.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Api, Project, Template } from '../../lib/api';

import { ProjectsDashboard } from './ProjectsDashboard';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: jest.fn() }) }));
jest.mock('next/link', () => ({
    __esModule: true,
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

const project = (id: string, name: string, updatedAt: string): Project => ({
    id,
    orgId: 'org-1',
    name,
    description: null,
    createdAt: updatedAt,
    updatedAt,
});

const TEMPLATE: Template = {
    id: 'tpl-1',
    orgId: null,
    name: 'RC low-pass',
    description: 'First-order filter',
    tags: ['filter'],
    circuitJson: {
        version: '1.0',
        components: [
            {
                id: 'r1',
                type: 'resistor',
                designator: 'R1',
                value: '1k',
                pins: [
                    { pinId: '1', netId: 'in' },
                    { pinId: '2', netId: 'out' },
                ],
            },
        ],
        nets: [
            { id: 'in', name: 'IN' },
            { id: 'out', name: 'OUT' },
        ],
    },
    analysisConfig: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
};

type FakeApi = jest.Mocked<
    Pick<
        Api,
        'orgs' | 'projects' | 'templates' | 'createProject' | 'saveWorkingCopy' | 'deleteProject' | 'updateProject'
    >
>;
let api: FakeApi;
let items: Project[];

jest.mock('../../app/providers', () => ({ useSession: () => ({ api, client: { signOut: jest.fn() } }) }));

beforeEach(() => {
    push.mockReset();
    items = [project('p1', 'Night light', '2026-10-01T10:00:00Z'), project('p2', 'Audio amp', '2026-10-15T10:00:00Z')];
    api = {
        orgs: jest.fn().mockResolvedValue([{ id: 'org-1', name: 'Acme Labs', role: 'OWNER' }]),
        projects: jest
            .fn()
            .mockImplementation(() =>
                Promise.resolve({ items: [...items], total: items.length, limit: 100, offset: 0, hasMore: false }),
            ),
        templates: jest.fn().mockResolvedValue([TEMPLATE]),
        createProject: jest.fn().mockResolvedValue(project('p-new', 'RC low-pass', '2026-10-17T10:00:00Z')),
        saveWorkingCopy: jest.fn().mockResolvedValue({ projectId: 'p-new', updatedAt: 'T1' }),
        deleteProject: jest.fn().mockImplementation((id: string) => {
            items = items.filter((p) => p.id !== id);
            return Promise.resolve({});
        }),
        updateProject: jest.fn(),
    } as unknown as FakeApi;
    window.localStorage.clear();
});

const cardNames = () => [...document.querySelectorAll('[data-testid="project-list"] h2')].map((h) => h.textContent);

/** Render, wait for the two seeded projects, and open the new-project dialog. */
async function openNewProject(): Promise<void> {
    render(<ProjectsDashboard />);
    await waitFor(() => expect(cardNames()).toHaveLength(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'New project' })[0]!);
}

describe('the projects page', () => {
    it('lists the org’s projects, most recently edited first, each linking to its own URL', async () => {
        render(<ProjectsDashboard />);
        await waitFor(() => expect(cardNames()).toEqual(['Audio amp', 'Night light']));
        expect(screen.getByText('Acme Labs')).toBeTruthy();
        expect(screen.getByText('Audio amp').closest('a')?.getAttribute('href')).toBe('/projects/p2');
    });

    it('filters by name as you type', async () => {
        render(<ProjectsDashboard />);
        await waitFor(() => expect(cardNames()).toHaveLength(2));
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), { target: { value: 'night' } });
        expect(cardNames()).toEqual(['Night light']);
    });

    it('creates a project from a template: the template circuit becomes its draft, then it opens', async () => {
        await openNewProject();
        fireEvent.click(await screen.findByRole('radio', { name: /RC low-pass/ }));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
        });
        expect(api.createProject).toHaveBeenCalledWith('org-1', {
            name: 'RC low-pass',
            description: 'First-order filter',
        });
        expect(api.saveWorkingCopy).toHaveBeenCalledWith('p-new', { circuitJson: TEMPLATE.circuitJson, uiJson: {} });
        expect(push).toHaveBeenCalledWith('/projects/p-new');
    });

    it('a blank project gets an empty circuit and the typed name', async () => {
        await openNewProject();
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My filter' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
        });
        expect(api.createProject).toHaveBeenCalledWith('org-1', { name: 'My filter' });
        expect(api.saveWorkingCopy).toHaveBeenCalledWith('p-new', {
            circuitJson: { version: '1.0', components: [], nets: [] },
            uiJson: {},
        });
    });

    it('deletes after confirmation and refreshes the list', async () => {
        jest.spyOn(window, 'confirm').mockReturnValue(true);
        render(<ProjectsDashboard />);
        await waitFor(() => expect(cardNames()).toHaveLength(2));
        await act(async () => {
            fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
        });
        expect(api.deleteProject).toHaveBeenCalledWith('p2');
        await waitFor(() => expect(cardNames()).toEqual(['Night light']));
    });

    it('shows an empty state with a way to start when there are no projects', async () => {
        items = [];
        render(<ProjectsDashboard />);
        expect(await screen.findByText('No projects yet')).toBeTruthy();
    });
});
