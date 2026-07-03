/**
 * Connectivity-parity check (approval condition 1 — the critical one).
 *
 * KiCad's DRC "0 unconnected" only proves the BOARD matches the tscircuit netlist; it says nothing
 * about the tscircuit netlist matching OURS. A pin-map bug in the adapter (BJT C<->E, diode
 * anode<->cathode, subckt pin shift) would produce a DRC-clean but electrically wrong board. This
 * module verifies, pin by pin, that tscircuit's evaluated connectivity is ISOMORPHIC to our
 * CircuitJson's pin->net partition.
 *
 * Two independent views are compared:
 *  - our own union-find over tscircuit's source_trace elements (computed here, from raw data);
 *  - tscircuit's own precomputed `subcircuit_connectivity_map_key`.
 * They must agree with each other AND with our expectations — a shared-fate bug in one view cannot
 * silently pass. Port identity is matched through `port_hints` (tscircuit's own semantic aliases,
 * e.g. anode/collector), NOT through the adapter's pin map — the anchor the review asked for.
 *
 * HONEST LIMIT: the check certifies that the traces the adapter EMITTED landed where their selectors
 * say — a STATIC pin-map typo that is consistent on both sides (e.g. mapping our 'c' to their 'b'
 * token everywhere) passes. That residue is covered by (a) the DIRECT_PIN_MAPS uniqueness/identity
 * unit tests and (b) the harness's semantic-anchor asserts against tscircuit's own hints on real
 * evaluated boards, which alarm on any upstream alias change.
 */
import type { PinExpectation } from './adapter';
import type { LayoutDiagnostic } from './layoutability';

/** The minimal slice of tscircuit's circuit-json we consume (structurally typed, version-tolerant). */
export interface TscElement {
    type: string;
    [k: string]: unknown;
}

export interface ParityResult {
    ok: boolean;
    diagnostics: LayoutDiagnostic[];
    /** pins checked / pins expected — both views agreed on every checked pin when ok. */
    checkedPins: number;
    expectedPins: number;
}

interface PortRec {
    id: string;
    componentName: string;
    names: Set<string>; // name + port_hints
    connKey?: string;
}

class UnionFind {
    private readonly parent = new Map<string, string>();
    find(x: string): string {
        let r = this.parent.get(x);
        if (r === undefined) {
            this.parent.set(x, x);
            return x;
        }
        if (r !== x) {
            r = this.find(r);
            this.parent.set(x, r);
        }
        return r;
    }
    union(a: string, b: string): void {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra !== rb) this.parent.set(ra, rb);
    }
}

export function checkConnectivityParity(evaluated: TscElement[], expectations: PinExpectation[]): ParityResult {
    const diagnostics: LayoutDiagnostic[] = [];

    if (expectations.length === 0) {
        // A board with NOTHING to verify must never be certified vacuously (zero-pin components /
        // empty net lists slip every other check — review finding, 3 Tem).
        diagnostics.push({
            code: 'PCB026',
            severity: 'error',
            message: 'parity: no pin expectations — nothing was verified; refusing a vacuous pass.',
        });
        return { ok: false, diagnostics, checkedPins: 0, expectedPins: 0 };
    }

    // ---- index tscircuit's source model
    const componentNameById = new Map<string, string>();
    for (const el of evaluated) {
        if (el.type === 'source_component') {
            componentNameById.set(String(el.source_component_id), String(el.name));
        }
    }
    const ports = new Map<string, PortRec>();
    const portsByComponent = new Map<string, PortRec[]>();
    for (const el of evaluated) {
        if (el.type !== 'source_port') continue;
        const componentName = componentNameById.get(String(el.source_component_id)) ?? '';
        const names = new Set<string>([String(el.name)]);
        for (const h of (el.port_hints as string[] | undefined) ?? []) names.add(String(h));
        const rec: PortRec = {
            id: String(el.source_port_id),
            componentName,
            names,
            connKey: el.subcircuit_connectivity_map_key ? String(el.subcircuit_connectivity_map_key) : undefined,
        };
        ports.set(rec.id, rec);
        const list = portsByComponent.get(componentName) ?? [];
        list.push(rec);
        portsByComponent.set(componentName, list);
    }
    const netIdByName = new Map<string, string>();
    for (const el of evaluated) {
        if (el.type === 'source_net') {
            netIdByName.set(String(el.name), String(el.source_net_id));
        }
    }

    // ---- view 1: OUR union-find over source_trace connections (raw data, computed here)
    const uf = new UnionFind();
    for (const el of evaluated) {
        if (el.type !== 'source_trace') continue;
        const members = [
            ...(((el.connected_source_port_ids as string[] | undefined) ?? []) as string[]),
            ...(((el.connected_source_net_ids as string[] | undefined) ?? []) as string[]),
        ];
        for (let i = 1; i < members.length; i++) uf.union(members[0]!, members[i]!);
    }

    // ---- check every expected pin in both views
    let checked = 0;
    const groupByExpectedNet = new Map<string, string>(); // netName -> UF group (short-circuit detector)
    for (const exp of expectations) {
        const candidates = portsByComponent.get(exp.name) ?? [];
        const portName = exp.selector.split('>')[1]?.trim().replace(/^\./, '') ?? '';
        const matches = candidates.filter((p) => p.names.has(portName));
        if (matches.length > 1) {
            // Upstream alias collision (seen live: transistor word-hints duplicated across pins). An
            // ambiguous selector may have bound the trace to the WRONG leg — refuse to certify.
            diagnostics.push({
                code: 'PCB025',
                severity: 'error',
                message: `parity: selector ${exp.selector} matches ${matches.length} ports (upstream alias collision) — connectivity cannot be certified.`,
            });
            continue;
        }
        const port = matches[0];
        if (!port) {
            diagnostics.push({
                code: 'PCB020',
                severity: 'error',
                message: `parity: port ${exp.selector} not found in the evaluated board (expected on net ${exp.netName}).`,
            });
            continue;
        }
        const netId = netIdByName.get(exp.netName);
        if (!netId) {
            diagnostics.push({
                code: 'PCB021',
                severity: 'error',
                message: `parity: net "${exp.netName}" was not materialized in the evaluated board.`,
            });
            continue;
        }
        // view 1: the port must be in the same UF group as its named net
        const portGroup = uf.find(port.id);
        if (portGroup !== uf.find(netId)) {
            diagnostics.push({
                code: 'PCB022',
                severity: 'error',
                message: `parity: ${exp.selector} is NOT connected to net ${exp.netName} in the evaluated board.`,
            });
            continue;
        }
        // shorts: two different expected nets must never share a group
        const prior = groupByExpectedNet.get(exp.netName);
        if (prior === undefined) {
            for (const [otherNet, otherGroup] of groupByExpectedNet) {
                if (otherGroup === portGroup && otherNet !== exp.netName) {
                    diagnostics.push({
                        code: 'PCB023',
                        severity: 'error',
                        message: `parity: nets ${otherNet} and ${exp.netName} are SHORTED in the evaluated board.`,
                    });
                }
            }
            groupByExpectedNet.set(exp.netName, portGroup);
        }
        checked++;
    }

    // ---- view 2: tscircuit's own connectivity keys must agree with view 1 (mutual verification)
    const keyToGroup = new Map<string, string>();
    for (const port of ports.values()) {
        if (!port.connKey) continue;
        const group = uf.find(port.id);
        const prior = keyToGroup.get(port.connKey);
        if (prior === undefined) {
            keyToGroup.set(port.connKey, group);
        } else if (prior !== group) {
            diagnostics.push({
                code: 'PCB024',
                severity: 'error',
                message: `parity: tscircuit's connectivity key ${port.connKey} spans two of OUR trace-derived groups — the two views disagree; treat the board as unverified.`,
            });
        }
    }

    return {
        ok: !diagnostics.some((d) => d.severity === 'error'),
        diagnostics,
        checkedPins: checked,
        expectedPins: expectations.length,
    };
}
