import { checkConnectivityParity, type TscElement } from './parity';
import type { PinExpectation } from './adapter';

/** Build a minimal evaluated board: components, semantic-hinted ports, named nets, traces. */
function board(opts: {
    traces: Array<[string, string]>; // pairs of member ids (ports/nets)
    connKeys?: Record<string, string>;
}): TscElement[] {
    const els: TscElement[] = [
        { type: 'source_component', source_component_id: 'sc_R1', name: 'R1' },
        { type: 'source_component', source_component_id: 'sc_D1', name: 'D1' },
        { type: 'source_port', source_port_id: 'p_R1_1', name: 'pin1', port_hints: ['pin1', '1'], source_component_id: 'sc_R1', subcircuit_connectivity_map_key: opts.connKeys?.p_R1_1 },
        { type: 'source_port', source_port_id: 'p_R1_2', name: 'pin2', port_hints: ['pin2', '2'], source_component_id: 'sc_R1', subcircuit_connectivity_map_key: opts.connKeys?.p_R1_2 },
        { type: 'source_port', source_port_id: 'p_D1_a', name: 'pin1', port_hints: ['anode', 'pos', 'pin1'], source_component_id: 'sc_D1', subcircuit_connectivity_map_key: opts.connKeys?.p_D1_a },
        { type: 'source_port', source_port_id: 'p_D1_k', name: 'pin2', port_hints: ['cathode', 'neg', 'pin2'], source_component_id: 'sc_D1', subcircuit_connectivity_map_key: opts.connKeys?.p_D1_k },
        { type: 'source_net', source_net_id: 'net_VIN', name: 'VIN' },
        { type: 'source_net', source_net_id: 'net_GND', name: 'GND' },
    ];
    for (const [a, b] of opts.traces) {
        els.push({ type: 'source_trace', source_trace_id: `t_${a}_${b}`, connected_source_port_ids: [a, b].filter((x) => x.startsWith('p_')), connected_source_net_ids: [a, b].filter((x) => x.startsWith('net_')) });
    }
    return els;
}

const EXPECT: PinExpectation[] = [
    { name: 'R1', pinId: '1', selector: '.R1 > .pin1', netName: 'VIN' },
    { name: 'R1', pinId: '2', selector: '.R1 > .pin2', netName: 'GND' },
    { name: 'D1', pinId: 'anode', selector: '.D1 > .anode', netName: 'VIN' },
    { name: 'D1', pinId: 'cathode', selector: '.D1 > .cathode', netName: 'GND' },
];

describe('checkConnectivityParity (approval condition 1)', () => {
    it('REFUSES a vacuous pass: zero expectations -> PCB026 error, never ok (review finding)', () => {
        const r = checkConnectivityParity(board({ traces: [] }), []);
        expect(r.ok).toBe(false);
        expect(r.diagnostics.some((d) => d.code === 'PCB026')).toBe(true);
    });

    it('passes a correctly wired board — semantic hints (anode) resolve ports independent of the pin map', () => {
        const r = checkConnectivityParity(
            board({
                traces: [
                    ['p_R1_1', 'net_VIN'],
                    ['p_D1_a', 'net_VIN'],
                    ['p_R1_2', 'net_GND'],
                    ['p_D1_k', 'net_GND'],
                ],
            }),
            EXPECT,
        );
        expect(r.ok).toBe(true);
        expect(r.checkedPins).toBe(4);
    });

    it('catches a MISWIRED pin (diode flipped: anode landed on GND) — PCB022', () => {
        const r = checkConnectivityParity(
            board({
                traces: [
                    ['p_R1_1', 'net_VIN'],
                    ['p_D1_k', 'net_VIN'], // flipped!
                    ['p_R1_2', 'net_GND'],
                    ['p_D1_a', 'net_GND'], // flipped!
                ],
            }),
            EXPECT,
        );
        expect(r.ok).toBe(false);
        expect(r.diagnostics.filter((d) => d.code === 'PCB022')).toHaveLength(2);
    });

    it('catches a SHORT (two expected nets ended up in one group) — PCB023', () => {
        const r = checkConnectivityParity(
            board({
                traces: [
                    ['p_R1_1', 'net_VIN'],
                    ['p_D1_a', 'net_VIN'],
                    ['p_R1_2', 'net_GND'],
                    ['p_D1_k', 'net_GND'],
                    ['net_VIN', 'net_GND'], // bridge!
                ],
            }),
            EXPECT,
        );
        expect(r.ok).toBe(false);
        expect(r.diagnostics.some((d) => d.code === 'PCB023')).toBe(true);
    });

    it('reports a missing port (PCB020) and a never-materialized net (PCB021)', () => {
        const els = board({ traces: [['p_R1_1', 'net_VIN']] }).filter((e) => e.source_port_id !== 'p_D1_a');
        const r = checkConnectivityParity(els, [
            ...EXPECT,
            { name: 'R1', pinId: '2', selector: '.R1 > .pin2', netName: 'VOUT' }, // no such net
        ]);
        expect(r.diagnostics.some((d) => d.code === 'PCB020')).toBe(true);
        expect(r.diagnostics.some((d) => d.code === 'PCB021')).toBe(true);
        expect(r.ok).toBe(false);
    });

    it("cross-checks tscircuit's own connectivity keys against OUR trace-derived groups (PCB024)", () => {
        // Views disagree: their key says R1.pin1 and R1.pin2 are the same group; our traces say not.
        const r = checkConnectivityParity(
            board({
                traces: [
                    ['p_R1_1', 'net_VIN'],
                    ['p_D1_a', 'net_VIN'],
                    ['p_R1_2', 'net_GND'],
                    ['p_D1_k', 'net_GND'],
                ],
                connKeys: { p_R1_1: 'K1', p_R1_2: 'K1' }, // same key across two different groups
            }),
            EXPECT,
        );
        expect(r.ok).toBe(false);
        expect(r.diagnostics.some((d) => d.code === 'PCB024')).toBe(true);
    });
});
