/**
 * The reuse gates.
 *
 * This kernel is meant to be lifted into a separate frontend workspace VERBATIM. That promise is worth
 * nothing as an intention: checked at the end, the fix is a rewrite; checked from the first commit, a
 * violation is a red build the day someone writes it. So it is a test, and it runs in CI.
 *
 * Three things are guarded, and each has a specific accident behind it:
 *
 *   THE DEPENDENCY ALLOWLIST — the one that would actually happen. `LayoutGeometry` used to live in
 *   pcb-core, which pulls an evaluator, a footprint library and three format converters; importing it would
 *   have dragged the entire server toolchain into a browser bundle on one line. Extracting pcb-contract
 *   removed the temptation; this keeps the next one from landing.
 *
 *   NO DOM, NO NODE — enforced by the compiler (`lib:["ES2022"]`, `types:[]`), stated here so a reader who
 *   widens the tsconfig learns what it was for.
 *
 *   EVERYTHING IT SHIPS IS DECLARED — the gate that catches what the others cannot. Inside a pnpm
 *   workspace every sibling resolves whether or not it is declared, so a missing dependency is invisible
 *   until the package is consumed from somewhere else. Packing it and comparing every specifier in the
 *   shipped files — the emitted JavaScript AND the emitted declarations — against the tarball's own
 *   manifest is the only check that sees an undeclared one.
 *
 * WHAT NONE OF THEM PROVE: that the package can actually be INSTALLED. This file used to say it did, in
 * those words, and the claim was wrong twice over — it never ran an install, and its scan read only the
 * compiled JavaScript, where a type-only dependency has already vanished. So a declared, correct, never-
 * published dependency passed cleanly and would have failed at `npm i`. Proving installability needs a
 * real install against a real registry; that belongs in a release pipeline, and its absence is a stated
 * gap rather than a covered one.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    name: string;
    files?: string[];
    exports?: Record<string, unknown>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
};

/**
 * Everything the kernel may depend on, and nothing else.
 *
 * Both entries are themselves browser-safe and dependency-light — eda-core's only dependency is zod,
 * pcb-contract has none at all — so the closure this allows is genuinely small rather than nominally small.
 */
const ALLOWED = new Set(['@circuit-forge/eda-core', '@circuit-forge/pcb-contract']);

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return sourceFiles(full);
        return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [full] : [];
    });
}

describe('the kernel stays liftable', () => {
    it('depends on nothing outside the allowlist', () => {
        const declared = Object.keys({ ...PKG.dependencies, ...PKG.peerDependencies });
        expect(declared.filter((d) => !ALLOWED.has(d))).toEqual([]);
    });

    it('imports nothing outside the allowlist — including no React and no relative escape', () => {
        for (const file of sourceFiles(join(ROOT, 'src'))) {
            const src = readFileSync(file, 'utf8');
            const specifiers = [...src.matchAll(/^\s*(?:import|export)\s[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
            const foreign = specifiers.filter((s) => !s.startsWith('.') && !ALLOWED.has(s));
            // `../..` would reach outside the package and would not survive being lifted.
            const escaping = specifiers.filter((s) => s.startsWith('../..'));
            expect({ file, foreign, escaping }).toEqual({ file, foreign: [], escaping: [] });
        }
    });

    it('names no DOM or Node global — the compiler already refuses them', () => {
        for (const file of sourceFiles(join(ROOT, 'src'))) {
            // Comments AND string literals are stripped before the search. Comments were always excluded;
            // strings had to join them the day a module was named `./document/edits`, which is the correct
            // domain word for what it holds and which this gate reported as a use of the DOM's `document`.
            //
            // Bending the code to satisfy a text search would have been the wrong repair — the rule is "no
            // DOM or Node IDENTIFIER", and a path is not an identifier. The compiler is the real enforcement
            // here (`lib:["ES2022"]`, `types:[]` make these unresolvable); this stays as the statement of
            // intent a reader finds if someone widens the tsconfig, so making it precise costs nothing.
            const src = readFileSync(file, 'utf8')
                .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
                .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
            const hit = /\b(document|window|navigator|Buffer|process|__dirname|require)\b/.exec(src)?.[0] ?? null;
            expect({ file, hit }).toEqual({ file, hit: null });
        }
    });

    it('still catches a real DOM reference — otherwise the strip above would have gutted the gate', () => {
        // A guard on the guard. Loosening a check is exactly where a check quietly stops checking, so this
        // asserts the SAME predicate against source that genuinely violates it.
        const violating = "const el = document.getElementById('x');";
        const stripped = violating
            .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
            .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
        expect(/\b(document|window|navigator|Buffer|process|__dirname|require)\b/.exec(stripped)?.[0]).toBe('document');
    });

    it('publishes a resolvable entry point: exports map, types, and files limited to dist', () => {
        expect(PKG.files).toEqual(['dist']);
        expect(PKG.exports).toBeDefined();
        // A published package resolves through `exports`; a missing "types" condition silently degrades a
        // consumer to `any`, which is the failure that looks like everything working.
        expect((PKG.exports as { '.': { types?: string } })['.'].types).toBe('./dist/index.d.ts');
    });

    it('packs with every shipped import DECLARED — in the types as well as the code', () => {
        // WHAT THIS PROVES, stated narrowly on purpose. The workspace hides missing dependencies: a sibling
        // resolves whether or not it is declared. `npm pack` produces exactly what a consumer receives, so
        // comparing every non-relative specifier in the shipped files against the tarball's own manifest is
        // what catches an UNDECLARED one.
        //
        // WHAT IT DOES NOT PROVE, and this is written down because the omission already cost something.
        // This test does not install anything. Its header used to say it did, and a reader — me — repeated
        // that claim as fact. Resolving a manifest and installing a tarball are different acts: the first
        // says "the package asks for what it uses", the second says "what it asks for can be obtained".
        // A dependency that is declared, correct, and has never been published to the registry passes this
        // gate and fails at `npm i`. Proving otherwise needs a real install against a real registry, which
        // is a release-pipeline job, not a unit test.
        //
        // TYPES ARE SCANNED TOO, and that is the part that was missing rather than merely unstated. A
        // `import type { X } from 'pkg'` compiles away completely, so the emitted JavaScript never mentions
        // `pkg` — a JS-only scan reports a clean bill of health while the shipped `.d.ts` still requires
        // that package for any TypeScript consumer to compile. The gate passed VACUOUSLY for exactly this
        // reason, which is the worst way for a test to be wrong: it was green because it was looking in the
        // one place the evidence could not be.
        const out = mkdtempSync(join(tmpdir(), 'editor-core-pack-'));
        try {
            execFileSync('npm', ['pack', '--pack-destination', out], { cwd: ROOT, stdio: 'pipe', shell: true });
            const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'));
            expect(tarball).toBeDefined();
            // Extracted with the tarball named RELATIVELY, from inside the directory. An absolute
            // Windows path here makes MSYS tar read `C:` as a remote host ("Cannot connect to C:"),
            // which fails the gate for a reason that has nothing to do with the boundary — and a gate
            // that goes red for environmental noise is one people learn to ignore.
            execFileSync('tar', ['-xzf', tarball!], { cwd: out, stdio: 'pipe', shell: true });

            const packed = JSON.parse(readFileSync(join(out, 'package', 'package.json'), 'utf8')) as {
                dependencies?: Record<string, string>;
            };
            const declared = new Set(Object.keys(packed.dependencies ?? {}));

            const built = readdirSync(join(out, 'package', 'dist'), { recursive: true }) as string[];
            const js = built.filter((f) => typeof f === 'string' && f.endsWith('.js'));
            const dts = built.filter((f) => typeof f === 'string' && f.endsWith('.d.ts'));
            // Both non-empty, or the scan below is vacuous in the direction it is vacuous in — which is
            // precisely how this gate passed while shipping a dependency nobody could install.
            expect({ js: js.length > 0, dts: dts.length > 0 }).toEqual({ js: true, dts: true });

            /** Every module specifier a consumer's toolchain would have to resolve, from one shipped file. */
            const specifiersIn = (code: string): string[] => [
                ...[...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]!),
                // The declaration forms. `import type`/`export type` erase from JS but survive here, and
                // `import("pkg")` is what TypeScript emits for an inlined type reference.
                ...[...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!),
                ...[...code.matchAll(/\bimport\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]!),
            ];

            const undeclared = new Map<string, string>(); // specifier -> the file that needs it
            for (const f of [...js, ...dts]) {
                for (const spec of specifiersIn(readFileSync(join(out, 'package', 'dist', f), 'utf8'))) {
                    // A subpath import (`pkg/sub`) is satisfied by declaring `pkg`; a scoped package keeps
                    // two segments. Node builtins are not dependencies and this package must not use them
                    // anyway — the allowlist above is what enforces that.
                    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
                    if (!spec.startsWith('.') && !declared.has(pkg)) undeclared.set(spec, f);
                }
            }
            expect([...undeclared].map(([spec, f]) => `${spec} (needed by dist/${f})`)).toEqual([]);
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
    }, 120_000);
});
