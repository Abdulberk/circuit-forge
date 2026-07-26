/**
 * Netlist-generator correctness regressions (audit LOW #13 + #14):
 *  #13 — a ground-FIRST differential probe v(0,X) = -v(X) must NOT be rewritten to the sign-flipped v(X).
 *  #14 — a transformer's synthesized internal winding node (_wp/_ws) must be caught by the case-insensitive
 *        node-collision guard, not silently merged by ngspice with a colliding net node.
 */
import { rewriteProbeNodeRefs, transformerMidNodes, generateNetlist } from '../src/netlist/generator';
import type { TranAnalysis } from '../src/types/analysis';
import type { CircuitJson } from '../src/types/circuit';

describe('#13 rewriteProbeNodeRefs — dropping ground is sign-safe only when ground is the subtrahend', () => {
    // stand-in for the net-id/name -> sanitized-node map generate() builds
    const map = new Map<string, string>([['out', 'x_out'], ['rail', 'nrail']]);

    it('v(out,0) → v(x_out)  (v(out) - 0 = v(out): ground as SUBTRAHEND is safe to drop)', () => {
        expect(rewriteProbeNodeRefs('v(out,0)', map)).toBe('v(x_out)');
    });

    it('v(0,out) → ""  (v(0) - v(out) = -v(out): DROPPED, never the sign-flipped v(x_out))', () => {
        expect(rewriteProbeNodeRefs('v(0,out)', map)).toBe(''); // regression guard: was buggy "v(x_out)"
    });

    it('v(0,out) → v(x_out) with keepGroundFirstSingleEnded (noise/sens: sign irrelevant, must resolve to a real node)', () => {
        // The .noise/.sens branch passes this flag so a ground-first output is the sanitized single-ended
        // vector, NOT dropped — otherwise the `out || raw` fallback would emit an unresolvable raw net id.
        expect(rewriteProbeNodeRefs('v(0,out)', map, true)).toBe('v(x_out)');
    });

    it('v(0)   → ""      (a pure-ground probe is meaningless → dropped)', () => {
        expect(rewriteProbeNodeRefs('v(0)', map)).toBe('');
    });

    it('v(out) → v(x_out) (simple single-ended remap still works)', () => {
        expect(rewriteProbeNodeRefs('v(out)', map)).toBe('v(x_out)');
    });

    it('v(out,rail) → v(x_out,nrail) (a non-ground differential is preserved, both operands remapped)', () => {
        expect(rewriteProbeNodeRefs('v(out,rail)', map)).toBe('v(x_out,nrail)');
    });

    it('v(x_out) → v(x_out) (an already-sanitized probe passes through verbatim)', () => {
        expect(rewriteProbeNodeRefs('v(x_out)', map)).toBe('v(x_out)');
    });
});

describe('#14 transformer internal winding nodes go through the case-insensitive node-collision guard', () => {
    const TRAN: TranAnalysis = { type: 'tran', stopTime: '60u', stepTime: '1u' };

    // Transformer with `designator` → internal node `${designator}_wp`. A net id "1_wp" sanitizes to node
    // "n1_wp"; so a transformer named "N1" (node "N1_wp", lower-cased "n1_wp") collides with it case-insensitively.
    const build = (transformerDesignator: string): CircuitJson => ({
        version: '1.0',
        components: [
            { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 1 50k)', pins: [{ pinId: '+', netId: 'prim' }, { pinId: '-', netId: 'gnd' }] },
            {
                id: 't1', type: 'transformer', designator: transformerDesignator,
                properties: { primaryInductance: '100m', secondaryInductance: '25m' },
                pins: [{ pinId: 'p+', netId: 'prim' }, { pinId: 'p-', netId: 'gnd' }, { pinId: 's+', netId: '1_wp' }, { pinId: 's-', netId: 'gnd' }],
            },
            { id: 'rl', type: 'resistor', designator: 'RL1', value: '1k', pins: [{ pinId: '1', netId: '1_wp' }, { pinId: '2', netId: 'gnd' }] },
        ],
        nets: [{ id: 'prim', name: 'PRIM' }, { id: '1_wp', name: 'W' }, { id: 'gnd', name: 'GND', isGround: true }],
    });

    it('helper node names are deterministic from the designator', () => {
        expect(transformerMidNodes('T1')).toEqual({ pMid: 'T1_wp', sMid: 'T1_ws' });
    });

    it('THROWS a loud collision error when a net case-insensitively equals a transformer internal node', () => {
        // designator "N1" → node "N1_wp" (lower "n1_wp") collides with net "1_wp" → node "n1_wp".
        expect(() => generateNetlist(build('N1'), TRAN)).toThrow(/collision/i);
    });

    it('does NOT throw for a transformer whose internal nodes do not collide with any net', () => {
        // designator "T5" → nodes "t5_wp"/"t5_ws" — no clash with net "1_wp" → "n1_wp".
        expect(() => generateNetlist(build('T5'), TRAN)).not.toThrow();
    });
});
