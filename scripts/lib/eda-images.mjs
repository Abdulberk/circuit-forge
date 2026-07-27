/**
 * The EXACT EDA container images the product runs — by immutable digest, in one place.
 *
 * Why this file exists. `kicad/kicad:10.0-full` is a ROLLING tag: upstream republishes it for every 10.0.x
 * patch. Production has always been safe, because docker/pcb-runtime/Dockerfile pins the digest. The CI
 * gate and the local harnesses did not — they pulled the bare tag — so the moment upstream moved the tag,
 * the gate began judging boards with a KiCad that the product never runs.
 *
 * That is worse than a flaky gate. DRC is our manufacturability authority: if the gate's DRC and
 * production's DRC are different binaries, a green gate stops being evidence about the shipped product,
 * in either direction. Measured 27 Tem 2026: the tag resolved to sha256:142fed45…, while production runs
 * sha256:fd4b9a49… — a silent divergence that no test could see, because every side was "correct" about
 * the tag it was told to use.
 *
 * The rule is therefore: ONE place names the images, it names them by digest, and it refuses to disagree
 * with the production Dockerfile. Bumping KiCad means changing the Dockerfile and this file together —
 * `assertImagesMatchProduction()` makes forgetting either one loud instead of silent.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRODUCTION_DOCKERFILE = join(repoRoot, 'docker', 'pcb-runtime', 'Dockerfile');

/** kicad-cli 10 + the 3D model library. MUST equal the `FROM` pin in the production Dockerfile. */
export const KICAD_IMAGE =
    'kicad/kicad:10.0-full@sha256:fd4b9a49145872bbb1397d0eee4e10f50e69fbf25b1506d996216d120ff681e1';

/** freerouting 2.2.4 (2.2.3 mis-parses KiCad-10 DSNs, issue #676). MUST equal the `COPY --from` pin. */
export const FR_IMAGE =
    'ghcr.io/freerouting/freerouting:2.2.4@sha256:0d010c6bf13b562551e8cb41fb298090006033fa2850e5bfc678c98ecf47111e';

const digestOf = (ref) => ref.slice(ref.indexOf('@') + 1);

/**
 * Fail loudly if these refs have drifted from the image production actually builds on. Called by the
 * harnesses at startup so the check runs everywhere the images do, rather than living in a CI step that
 * only fires on some paths.
 *
 * Deliberately tolerant of a MISSING Dockerfile (returns quietly): the harnesses are also run from
 * published tarballs and shallow checkouts where docker/ is absent, and a hard failure there would be a
 * false alarm about something this file cannot check.
 */
export function assertImagesMatchProduction() {
    let dockerfile;
    try {
        dockerfile = readFileSync(PRODUCTION_DOCKERFILE, 'utf8');
    } catch {
        return; // not a full checkout — nothing to compare against
    }
    const missing = [
        ['KICAD_IMAGE', KICAD_IMAGE],
        ['FR_IMAGE', FR_IMAGE],
    ].filter(([, ref]) => !dockerfile.includes(digestOf(ref)));

    if (missing.length > 0) {
        throw new Error(
            `EDA image drift: ${missing.map(([name]) => name).join(' and ')} ` +
                `${missing.length === 1 ? 'no longer matches' : 'no longer match'} docker/pcb-runtime/Dockerfile. ` +
                `The gate would test a different binary than production runs. ` +
                `Update scripts/lib/eda-images.mjs and the Dockerfile together.`,
        );
    }
}
