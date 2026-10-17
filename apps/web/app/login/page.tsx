'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';

import { FullPageSpinner } from '../../components/shell/RequireAuth';
import { SignIn } from '../../components/SignIn';
import { useSession } from '../providers';

/** Only same-app paths: `?next=https://evil.example` must not turn sign-in into an open redirect. */
const safeNext = (raw: string | null): string =>
    raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/projects';

function Login() {
    const { signedIn } = useSession();
    const router = useRouter();
    const next = safeNext(useSearchParams().get('next'));

    useEffect(() => {
        if (signedIn === true) router.replace(next);
    }, [signedIn, router, next]);

    if (signedIn !== false) return <FullPageSpinner />;
    return <SignIn onSignedIn={() => router.replace(next)} />;
}

export default function LoginPage() {
    // `useSearchParams` needs a Suspense boundary for the static build.
    return (
        <Suspense fallback={<FullPageSpinner />}>
            <Login />
        </Suspense>
    );
}
