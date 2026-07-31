/**
 * Turning a board's simulation result into something a frame loop can read in O(1).
 *
 * PURE — no three.js, no React, no fetch. The join and the resampling are where a wrong answer would show
 * up as a confidently-lit trace, so they are kept where they can be reasoned about and tested on their own.
 *
 * THE JOIN. Geometry names a net ("VCC"); the simulation names a node ("x_vcc"). They meet only at the net
 * id, which neither carries — so the board ships `netIdentity` with both maps and this composes them. A net
 * whose signal cannot be found is NOT quietly skipped: it is listed in `unresolved`, because a trace left
 * unlit and a trace whose voltage we never had look identical on screen and are different facts.
 *
 * THE RESAMPLING. ngspice emits a non-uniform timebase (the solver takes the steps it needs). Playing that
 * back directly would mean a search per net per frame. Resampling once, at load, onto a uniform grid turns
 * playback into an array index — and the interpolation is linear between the two bracketing samples, which
 * is what the solver's own output already implies between its points.
 */

/** The layout half of a board's data: the copper, and how it joins to a simulation of the same circuit. */
export interface BoardLayout {
    geometry: {
        /** `outline` is the authoritative rectangle: the board frame is NOT centred on the origin (a
         *  measured example spans x −26.084 … 23.02 on a 49.104 mm board), so width/height alone cannot
         *  place anything. Everything geometric is registered against these corners. */
        board: { widthMm: number; heightMm: number; outline: Array<{ x: number; y: number }> };
        traces: Array<{
            id: string;
            net: string | null;
            segments: Array<{ layer: string; widthMm: number; points: Array<{ x: number; y: number }> }>;
        }>;
    };
    netIdentity: {
        /** netId -> the net name that appears on the geometry. */
        nameById: Record<string, string>;
        /** netId -> the SPICE node name the simulation reports (`v(<node>)`). */
        spiceNodeById: Record<string, string>;
    };
}

/** A component the deck left out because it has no electrical model. Mirrors eda-core's `OmittedComponent`
 *  — the viewer reads it, it does not define it. */
export interface OmittedComponent {
    designator: string;
    type: string;
    netIds: string[];
    /** Whether the omission puts an open where a device belongs, i.e. the waveforms stop describing the
     *  board as drawn. A test point is omitted too and costs the result nothing. */
    loadBearing: boolean;
}
export interface SimulationCoverage {
    omitted: OmittedComponent[];
    loadBearing: OmittedComponent[];
    complete: boolean;
}

/** The simulation half. `available: false` carries WHY — a board at steady state and a board we could not
 *  simulate look the same in a waveform and are not the same fact. `coverage` answers a third case that
 *  looks identical to both: the run succeeded, but the part that would have made something happen has no
 *  simulatable model and was never in the deck. */
export type BoardSim = { coverage?: SimulationCoverage } & (
    | { available: false; reason: string }
    | {
          available: true;
          note?: string;
          result: { series: Array<{ name: string; unit?: string; points: Array<{ x: number; y: number }> }> };
      }
);

export interface Playback {
    /** Net names, in the order their values are packed. The index IS the shader's net index. */
    nets: string[];
    /** frames × nets, row-major: `values[frame * nets.length + net]`. Volts. */
    values: Float32Array;
    /** Simulation time (seconds) at each frame — for the readout, not for lookup. */
    times: Float32Array;
    frames: number;
    /** Value range across the whole run, so a colour map is stable while the animation plays. */
    min: number;
    max: number;
    /** Nets that carry copper but no simulation signal. Disclosed, never silently dark. */
    unresolved: string[];
}

/** Net name -> SPICE node, composed from the two id-keyed maps the board ships. */
export function nodeByNetName(identity: BoardLayout['netIdentity']): Map<string, string> {
    const out = new Map<string, string>();
    for (const [netId, netName] of Object.entries(identity.nameById)) {
        const node = identity.spiceNodeById[netId];
        if (node !== undefined) out.set(netName, node);
    }
    return out;
}

/** The series name ngspice reports for a node, as it appears in the wrdata header. */
const seriesNameFor = (node: string): string => `v(${node})`;

/**
 * SPICE's reference node. The generator maps ground to node `0`, and no simulator emits `v(0)` — it is the
 * datum every other voltage is measured against, so there is nothing to emit.
 *
 * That made ground look UNRESOLVED on every board: the largest area of copper on the card, reported as a
 * net whose voltage we never had. We do have it. It is zero, by the definition of the analysis. Treating
 * the reference as known is not a special case bolted on for a nice picture — reporting it as unknown was
 * the error.
 */
const SPICE_REFERENCE_NODE = '0';

/**
 * Linear interpolation of a non-uniform series onto a uniform grid.
 *
 * Walks both sequences once (the source is time-ordered), so building the whole table is O(points + frames)
 * per net rather than a binary search per frame.
 */
function resample(points: Array<{ x: number; y: number }>, times: Float32Array, out: Float32Array, stride: number, slot: number): void {
    if (points.length === 0) return;
    let i = 0;
    for (let f = 0; f < times.length; f++) {
        const t = times[f]!;
        while (i < points.length - 2 && points[i + 1]!.x < t) i++;
        const a = points[i]!;
        const b = points[Math.min(i + 1, points.length - 1)]!;
        const span = b.x - a.x;
        // A zero span means duplicate timestamps; take the earlier sample rather than dividing by zero.
        const k = span > 0 ? Math.min(1, Math.max(0, (t - a.x) / span)) : 0;
        out[f * stride + slot] = a.y + (b.y - a.y) * k;
    }
}

/**
 * Build the playback table for the nets that actually carry copper.
 *
 * `frames` is the animation's resolution, not the solver's: the solver's own step count is a property of how
 * hard the circuit was to solve, and binding playback to it would make a stiff circuit play back at a
 * different speed than an easy one.
 */
export function buildPlayback(layout: BoardLayout, sim: BoardSim, frames = 240): Playback | null {
    if (!sim.available) return null;

    const byName = new Map(sim.result.series.map((s) => [s.name.toLowerCase(), s]));
    const node = nodeByNetName(layout.netIdentity);

    const onCopper = [...new Set(layout.geometry.traces.map((t) => t.net).filter((n): n is string => !!n))].sort();
    const nets: string[] = [];
    const series: Array<{ points: Array<{ x: number; y: number }> } | 'reference'> = [];
    const unresolved: string[] = [];
    for (const net of onCopper) {
        const spice = node.get(net);
        if (spice === SPICE_REFERENCE_NODE) {
            nets.push(net);
            series.push('reference');
            continue;
        }
        const s = spice ? byName.get(seriesNameFor(spice).toLowerCase()) : undefined;
        if (!s) {
            unresolved.push(net);
            continue;
        }
        nets.push(net);
        series.push(s);
    }
    // A board whose ONLY resolved net is ground has nothing to animate: every trace would sit at the same
    // constant. That is a still picture, and the caller must be able to say so rather than show one.
    if (nets.length === 0 || series.every((s) => s === 'reference')) return null;

    // One timebase for the whole board: the widest span any of its signals covers.
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const s of series) {
        if (s === 'reference' || s.points.length === 0) continue; // the datum spans whatever the run does
        t0 = Math.min(t0, s.points[0]!.x);
        t1 = Math.max(t1, s.points[s.points.length - 1]!.x);
    }
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;

    const times = new Float32Array(frames);
    for (let f = 0; f < frames; f++) times[f] = t0 + ((t1 - t0) * f) / (frames - 1);

    // Zero-initialised, which is already the reference node's value — so 'reference' nets need no work.
    const values = new Float32Array(frames * nets.length);
    for (let n = 0; n < nets.length; n++) {
        const s = series[n]!;
        if (s !== 'reference') resample(s.points, times, values, nets.length, n);
    }

    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    // A perfectly flat board is a real answer (a regulated rail). Give the colour map a non-zero span so it
    // renders as one steady colour instead of dividing by zero.
    if (!(max > min)) {
        max = min + 1;
    }

    return { nets, values, times, frames, min, max, unresolved };
}
