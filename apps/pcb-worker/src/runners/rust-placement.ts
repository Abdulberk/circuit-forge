/**
 * Isolated bridge to the optional Rust PCB placer.
 *
 * The binary contract is deliberately small and version-independent:
 *
 *   cf-pcb-place <input.json> <output.json>
 *
 * Both files use pcb-core's PlacementInput / PlacementOutput JSON shapes. Keeping Rust in a child
 * process means a panic cannot take the BullMQ worker down, and gives us a real timeout boundary.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PlacementInput, PlacementOutput } from '@circuit-forge/pcb-core';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export interface RustPlacementOpts {
  /** Executable path. Resolution order: this value -> RUST_PLACER_PATH -> PATH lookup. */
  binary?: string;
  timeoutMs?: number;
  /** Caps captured stdout/stderr and the JSON output file. */
  maxBuffer?: number;
  workDir?: string;
  /** Preserve the per-call directory for debugging. Never enable in the production worker. */
  keep?: boolean;
}

export type RustPlacementRunner = (input: PlacementInput) => Promise<PlacementOutput>;

interface ChildFailure extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stderr?: string | Buffer;
}

function stderrText(value: string | Buffer | undefined): string {
  const raw = Buffer.isBuffer(value) ? value.toString('utf8') : (value ?? '');
  const compact = raw.trim();
  return compact.length > 4_096 ? `${compact.slice(0, 4_096)}...` : compact;
}

function childError(error: unknown, binary: string, timeoutMs: number, maxBuffer: number): Error {
  const e = error as ChildFailure;
  if (e.code === 'ENOENT') {
    return new Error(
      `Rust placement binary not found: "${binary}". Set RUST_PLACER_PATH or pass { binary } to makeRustPlacementRunner().`,
    );
  }
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new Error(`Rust placement binary exceeded the ${maxBuffer}-byte stdout/stderr limit.`);
  }
  if (e.killed) {
    return new Error(
      `Rust placement binary timed out after ${timeoutMs}ms${e.signal ? ` (signal ${e.signal})` : ''}.`,
    );
  }

  const exit =
    typeof e.code === 'number' ? `exit ${e.code}` : e.code ? `code ${e.code}` : 'unknown exit';
  const detail = stderrText(e.stderr);
  return new Error(
    `Rust placement binary failed (${exit}${e.signal ? `, signal ${e.signal}` : ''})${detail ? `: ${detail}` : '.'}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate the native boundary before untrusted output reaches pcb-core's acceptance ladder. */
function parseOutput(raw: string, input: PlacementInput): PlacementOutput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Rust placement binary produced invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) throw new Error('Rust placement output must be a JSON object.');
  if (typeof value.ok !== 'boolean')
    throw new Error('Rust placement output field "ok" must be boolean.');
  if (!finite(value.boardW) || value.boardW <= 0)
    throw new Error('Rust placement output field "boardW" must be a positive finite number.');
  if (!finite(value.boardH) || value.boardH <= 0)
    throw new Error('Rust placement output field "boardH" must be a positive finite number.');
  if (!finite(value.hpwl) || value.hpwl < 0)
    throw new Error('Rust placement output field "hpwl" must be a non-negative finite number.');
  if (!Array.isArray(value.notes) || value.notes.some((note) => typeof note !== 'string')) {
    throw new Error('Rust placement output field "notes" must be an array of strings.');
  }
  if (!isRecord(value.positions))
    throw new Error('Rust placement output field "positions" must be an object.');

  const expectedIds = new Set(input.parts.map((part) => part.id));
  const actualIds = Object.keys(value.positions);
  for (const id of actualIds) {
    if (!expectedIds.has(id))
      throw new Error(`Rust placement output contains unknown part id "${id}".`);
    const position = value.positions[id];
    if (!isRecord(position) || !finite(position.x) || !finite(position.y)) {
      throw new Error(
        `Rust placement output position for "${id}" must contain finite x/y coordinates.`,
      );
    }
    if (
      position.rotation !== 0 &&
      position.rotation !== 90 &&
      position.rotation !== 180 &&
      position.rotation !== 270
    ) {
      throw new Error(`Rust placement output position for "${id}" has an invalid rotation.`);
    }
  }
  if (value.ok) {
    for (const id of expectedIds) {
      if (!(id in value.positions))
        throw new Error(`Rust placement output is missing part id "${id}".`);
    }
  }

  return value as unknown as PlacementOutput;
}

export function makeRustPlacementRunner(opts: RustPlacementOpts = {}): RustPlacementRunner {
  const binary = opts.binary ?? process.env.RUST_PLACER_PATH ?? 'cf-pcb-place';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const baseDir = opts.workDir ?? tmpdir();

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Rust placement timeoutMs must be a positive finite number.');
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0)
    throw new Error('Rust placement maxBuffer must be a positive safe integer.');

  return async function rustPlace(input: PlacementInput): Promise<PlacementOutput> {
    const dir = await mkdtemp(join(baseDir, 'rust-place-'));
    const inputPath = join(dir, 'input.json');
    const outputPath = join(dir, 'output.json');
    try {
      let inputJson: string;
      try {
        inputJson = JSON.stringify(input);
      } catch (error) {
        throw new Error(
          `Rust placement input could not be serialized: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await writeFile(inputPath, inputJson, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

      try {
        // No shell and no user-controlled arguments: only our private temp paths reach the process.
        await execFileAsync(binary, [inputPath, outputPath], {
          timeout: timeoutMs,
          maxBuffer,
          windowsHide: true,
        });
      } catch (error) {
        throw childError(error, binary, timeoutMs, maxBuffer);
      }

      let outputSize: number;
      try {
        outputSize = (await stat(outputPath)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            'Rust placement binary exited successfully but did not create output.json.',
          );
        }
        throw error;
      }
      if (outputSize > maxBuffer) {
        throw new Error(`Rust placement output exceeded the ${maxBuffer}-byte JSON limit.`);
      }
      const raw = await readFile(outputPath, 'utf8');
      return parseOutput(raw, input);
    } finally {
      if (!opts.keep) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
