/**
 * The studio is a pure client of the API — it holds no database, no queue and no secret.
 *
 * `reactStrictMode` stays on deliberately. In development React 19 mounts every effect twice, which is
 * exactly the pressure an editor needs: a subscription that is not cleaned up, a poll that is not aborted or
 * a listener that is registered twice shows up on the first render instead of as a slow leak in a long
 * session. The alternative — turning it off to quiet the noise — hides the bug rather than the symptom.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
    /**
     * WHERE THE BUILD OUTPUT GOES, so a build cannot destroy a running dev server.
     *
     * They share `.next` by default: `next build` rewrites the chunk manifest that `next dev` is serving
     * from, and the page then loads its shell and 404s on `main-app.js`, `layout.js` and `polyfills.js` —
     * the browser shows a blank page that says "loading" forever, with the server answering 200 and nothing
     * in its log to suggest a problem. It happened for real: a build run to verify a change took down the
     * founder's editor, and the symptom pointed at the change rather than at the build.
     *
     * Verifying a build while somebody has the editor open is ordinary — it is what CI does and what anyone
     * checking their own work does — so the two outputs are kept apart rather than the practice forbidden.
     */
    distDir: process.env.NEXT_DIST_DIR || '.next',
    reactStrictMode: true,
    eslint: {
        // Lint runs as its own task in the pipeline (`pnpm lint`), against the same root config as every
        // other package. Running it a second time inside `next build` would apply a DIFFERENT rule set to the
        // same files, so a build could pass what the repo's linter rejects, or the reverse.
        ignoreDuringBuilds: true,
    },
};

export default nextConfig;
