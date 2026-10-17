/**
 * A production build that CANNOT take down a running dev server.
 *
 * `next build` and `next dev` share `.next` by default, and a build rewrites the chunk manifest the dev
 * server is serving from. The page then loads its shell and 404s on `main-app.js`, `layout.js` and
 * `polyfills.js`: a blank screen that says "loading" forever, while the server answers 200 and logs nothing.
 * It happened for real — a build run to verify a change took down the editor somebody had open, and the
 * symptom pointed at the change rather than at the build.
 *
 * Verifying a build while somebody has the editor open is ordinary work, so the outputs are kept apart
 * instead of the practice being forbidden. `next.config.mjs` reads `NEXT_DIST_DIR`; this sets it.
 *
 * Spawned rather than set with a shell prefix, because `VAR=value cmd` is not syntax on Windows and this
 * repo is developed there — a script that only works on one platform is one that fails on the machine of
 * whoever did not write it.
 */

import { spawnSync } from 'node:child_process';

const out = process.env.NEXT_DIST_DIR ?? '.next-check';
const result = spawnSync('next', ['build'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, NEXT_DIST_DIR: out },
});

process.exit(result.status ?? 1);
