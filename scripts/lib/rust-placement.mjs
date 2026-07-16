/**
 * Thin benchmark-side client for the standalone Rust PCB placer.
 *
 * Stable JSON ABI:
 *   cf-pcb-place <placement-input.json> <placement-output.json>
 *
 * The JSON documents are pcb-core's camelCase PlacementInput and
 * PlacementOutput respectively.  Keeping this adapter outside pcb-core lets
 * the Rust candidate be benchmarked without changing the production API.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

function asPath(value) {
    if (!value) return null;
    return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

/** Resolve the release binary without building or mutating the repository. */
export function resolveRustPlacerBinary(explicitPath) {
    const configured = explicitPath ?? process.env.RUST_PLACER_PATH;
    if (configured) {
        const candidate = asPath(configured);
        if (!existsSync(candidate)) {
            throw new Error(`Rust placer binary not found at ${candidate} (from RUST_PLACER_PATH)`);
        }
        return candidate;
    }

    const exe = process.platform === 'win32' ? 'cf-pcb-place.exe' : 'cf-pcb-place';
    const candidates = [
        join(repoRoot, 'crates', 'pcb-placement-rs', 'target', 'release', exe),
        join(repoRoot, 'target', 'release', exe),
    ];
    const found = candidates.find(existsSync);
    if (found) return found;

    throw new Error(
        `Rust placer binary not found. Build crates/pcb-placement-rs in release mode or set ` +
        `RUST_PLACER_PATH. Checked: ${candidates.join(', ')}`,
    );
}

/**
 * Execute one isolated placement. The caller's wall-clock measurement includes
 * JSON serialization, filesystem I/O and process startup: those costs are real
 * for the proposed standalone-binary integration.
 */
export function runRustPlacement(input, options = {}) {
    const binary = resolveRustPlacerBinary(options.binary);
    const timeoutMs = options.timeoutMs ?? Number(process.env.RUST_PLACER_TIMEOUT_MS ?? 120_000);
    const dir = mkdtempSync(join(tmpdir(), 'cf-rust-placement-'));
    const inputPath = join(dir, 'input.json');
    const outputPath = join(dir, 'output.json');

    try {
        writeFileSync(inputPath, JSON.stringify(input));
        const child = spawnSync(binary, [inputPath, outputPath], {
            encoding: 'utf8',
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });

        if (child.error) {
            throw new Error(`Rust placer could not start: ${child.error.message}`);
        }
        if (child.status !== 0) {
            const stderr = String(child.stderr ?? '').trim();
            const stdout = String(child.stdout ?? '').trim();
            throw new Error(
                `Rust placer exited ${child.status ?? 'without a status'}` +
                `${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ''}`,
            );
        }
        if (!existsSync(outputPath)) {
            throw new Error('Rust placer exited successfully but did not create its output JSON');
        }

        try {
            return JSON.parse(readFileSync(outputPath, 'utf8'));
        } catch (error) {
            throw new Error(`Rust placer emitted invalid output JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

