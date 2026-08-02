/**
 * The gate that gives this package its reason to exist.
 *
 * These modules used to live in `pcb-core`, and answering "does U3 have a footprint?" therefore meant
 * depending on an evaluator, a footprint library and three format converters — the whole board toolchain,
 * installed into the API to look up a pin count. Extracting them is only worth anything if the extraction
 * STAYS light, and an intention does not stay anything. So it is a test.
 *
 * The same discipline as `pcb-contract` and `editor-core`, for the same reason: checked at the end, the fix
 * is a rewrite; checked from the first commit, a violation is a red build the day someone writes it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    files?: string[];
    exports?: Record<string, { types?: string }>;
};

/**
 * The ONE thing this package may install.
 *
 * `@tscircuit/footprinter` is deliberately NOT here: it is an optional peer, reached through a dynamic
 * import inside `loadPadCountOracle` and needed only by a caller that wants pad accounting. A consumer that
 * only asks "can this be laid out at all" — the API — never pays for it.
 */
const ALLOWED_DEPS = new Set(['@circuit-forge/eda-core']);

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return sourceFiles(full);
        return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [full] : [];
    });
}

describe('preflight stays cheap to depend on', () => {
    it('installs exactly one package, and it is not the board toolchain', () => {
        expect(Object.keys(PKG.dependencies ?? {}).filter((d) => !ALLOWED_DEPS.has(d))).toEqual([]);
        // The heavy ones by name, so a reader sees precisely what this package exists to keep out.
        for (const heavy of ['@tscircuit/eval', 'circuit-json-to-gerber', 'circuit-json-to-kicad', 'dsn-converter']) {
            expect({ heavy, declared: heavy in (PKG.dependencies ?? {}) }).toEqual({ heavy, declared: false });
        }
    });

    it('declares the footprinter as an OPTIONAL peer — its absence is a supported state', () => {
        // Not a hard dependency, because `classifyCircuit` works without it and says so (PCB006) rather than
        // passing silently. Not undeclared either: a dynamic import nobody declared is how a package works
        // in the workspace and fails in the image it ships in.
        expect(PKG.peerDependencies?.['@tscircuit/footprinter']).toBeDefined();
        expect(PKG.peerDependenciesMeta?.['@tscircuit/footprinter']?.optional).toBe(true);
    });

    it('imports nothing outside the allowlist, and reaches the footprinter only DYNAMICALLY', () => {
        for (const file of sourceFiles(join(ROOT, 'src'))) {
            const src = readFileSync(file, 'utf8');
            const statics = [...src.matchAll(/^\s*(?:import|export)\s[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
            const foreign = statics.filter((s) => !s.startsWith('.') && !ALLOWED_DEPS.has(s));
            // A STATIC import of the footprinter would make the optional peer mandatory — and would not even
            // compile, because it is ESM-only and this package emits CommonJS. Both guards, stated once.
            expect({ file, foreign }).toEqual({ file, foreign: [] });
        }
    });

    it('names no DOM or Node global — this package reads no file and opens no socket', () => {
        for (const file of sourceFiles(join(ROOT, 'src'))) {
            const src = readFileSync(file, 'utf8')
                .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
                .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
            const hit = /\b(document|window|navigator|Buffer|process|__dirname|require)\b/.exec(src)?.[0] ?? null;
            expect({ file, hit }).toEqual({ file, hit: null });
        }
    });

    it('keeps the dynamic import DYNAMIC in the built output', () => {
        // The one that would fail silently. `module: node16` preserves `await import()`; a flat CommonJS
        // build down-compiles it to `require()`, which cannot load an ESM-only package — so the oracle would
        // throw at runtime in production while every test passed.
        const built = readFileSync(join(ROOT, 'dist', 'footprints.js'), 'utf8');
        expect(built).toMatch(/await import\(/);
        expect(built).not.toMatch(/require\(["']@tscircuit\/footprinter["']\)/);
    });

    it('publishes a resolvable entry point', () => {
        expect(PKG.files).toEqual(['dist']);
        expect(PKG.exports?.['.']?.types).toBe('./dist/index.d.ts');
    });

    it('packs and resolves OUTSIDE the workspace — every runtime import is declared', () => {
        // Inside a pnpm workspace every sibling resolves whether or not it is declared, so a missing
        // dependency stays invisible until the package is consumed from somewhere else. Packing it and
        // checking the built output against the tarball's own manifest is the only check that sees it.
        const out = mkdtempSync(join(tmpdir(), 'pcb-preflight-pack-'));
        try {
            execFileSync('npm', ['pack', '--pack-destination', out], { cwd: ROOT, stdio: 'pipe', shell: true });
            const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'));
            expect(tarball).toBeDefined();
            // Relative name, from inside the directory: an absolute Windows path makes MSYS tar read
            // `C:` as a remote host, which fails the gate for a reason unrelated to the boundary.
            execFileSync('tar', ['-xzf', tarball!], { cwd: out, stdio: 'pipe', shell: true });

            const packed = JSON.parse(readFileSync(join(out, 'package', 'package.json'), 'utf8')) as {
                dependencies?: Record<string, string>;
                peerDependencies?: Record<string, string>;
            };
            const declared = new Set([
                ...Object.keys(packed.dependencies ?? {}),
                ...Object.keys(packed.peerDependencies ?? {}),
            ]);

            const js = (readdirSync(join(out, 'package', 'dist'), { recursive: true }) as string[]).filter(
                (f) => typeof f === 'string' && f.endsWith('.js'),
            );
            expect(js.length).toBeGreaterThan(0); // an empty dist would make this vacuous

            const undeclared = new Set<string>();
            for (const f of js) {
                const code = readFileSync(join(out, 'package', 'dist', f), 'utf8');
                // Both forms: a static require and the dynamic import that reaches the optional peer.
                for (const m of [...code.matchAll(/require\("([^"]+)"\)/g), ...code.matchAll(/import\("([^"]+)"\)/g)]) {
                    const spec = m[1]!;
                    if (!spec.startsWith('.') && !declared.has(spec)) undeclared.add(spec);
                }
            }
            expect([...undeclared]).toEqual([]);
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
    }, 120_000);
});
