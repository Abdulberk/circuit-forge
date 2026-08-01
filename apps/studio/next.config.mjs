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
    reactStrictMode: true,
    eslint: {
        // Lint runs as its own task in the pipeline (`pnpm lint`), against the same root config as every
        // other package. Running it a second time inside `next build` would apply a DIFFERENT rule set to the
        // same files, so a build could pass what the repo's linter rejects, or the reverse.
        ignoreDuringBuilds: true,
    },
};

export default nextConfig;
