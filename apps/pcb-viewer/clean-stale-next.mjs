/**
 * Remove a PRODUCTION .next before starting the dev server.
 *
 * `next build` and `next dev` share the .next directory but write incompatible server output. After a
 * production build, dev reuses the production `pages/_document.js`, whose webpack runtime requires
 * numbered chunks that dev never emits — the browser then shows `Cannot find module './349.js'` with a
 * require stack pointing into .next/server, which reads like a broken install rather than a stale
 * directory. Next 14.2 does not detect this itself.
 *
 * BUILD_ID exists only after a production build, so it is the exact discriminator: dev-only .next
 * directories are left alone and keep their warm cache.
 */
import { existsSync, rmSync } from 'node:fs';

if (existsSync('.next/BUILD_ID')) {
    rmSync('.next', { recursive: true, force: true });
    console.log('[pcb-viewer] removed a production .next so the dev server starts clean');
}
