'use client';

import { useState } from 'react';

import { useSession } from '../../app/providers';
import { useAsync } from '../../lib/useAsync';

const ORG_KEY = 'cf-org';

/**
 * The organisation the user is working in: the one they last chose, while they still belong to it,
 * otherwise their first. Remembered on this device so the projects page reopens where it was left.
 */
export function useActiveOrg() {
    const { api } = useSession();
    const orgs = useAsync((signal) => api.orgs(signal), []);
    const [chosen, setChosen] = useState<string | null>(() => {
        try {
            return typeof window === 'undefined' ? null : window.localStorage.getItem(ORG_KEY);
        } catch {
            return null;
        }
    });
    const orgId = (orgs.data ?? []).some((o) => o.id === chosen) ? chosen : (orgs.data?.[0]?.id ?? null);
    const org = orgs.data?.find((o) => o.id === orgId);

    const chooseOrg = (id: string): void => {
        setChosen(id);
        try {
            window.localStorage.setItem(ORG_KEY, id);
        } catch {
            // Private mode: the choice lasts for this page only.
        }
    };

    return { orgs, orgId, org, chooseOrg };
}
