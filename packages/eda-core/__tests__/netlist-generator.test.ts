/**
 * Netlist Generator Tests
 */
import { generateNetlist, getNodeNames, validateNetlist } from '../src/netlist/generator';
import type { NetlistOptions } from '../src/netlist/generator';
import type { TranAnalysis, AcAnalysis, DcAnalysis, OpAnalysis } from '../src/types/analysis';
import type { CircuitJson, Component, Net } from '../src/types/circuit';
import { isSimulatable } from '../src/types/circuit';

// Helper to create a component
function createComponent(
    id: string,
    type: Component['type'],
    designator: string,
    value: string | undefined,
    pins: Array<{ pinId: string; netId: string }>,
): Component {
    return { id, type, designator, value, pins };
}

// Helper to create a net
function createNet(id: string, name: string, isGround = false): Net {
    return { id, name, isGround };
}

describe('NetlistGenerator', () => {
    describe('generateNetlist', () => {
        it('should generate a basic RC circuit netlist', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vcc' },
                        { pinId: '2', netId: 'out' },
                    ]),
                    createComponent('C1', 'capacitor', 'C1', '100n', [
                        { pinId: '1', netId: 'out' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('vcc', 'vcc'), createNet('out', 'out'), createNet('0', '0', true)],
            };

            const analysis: TranAnalysis = {
                type: 'tran',
                stopTime: '10m',
            };

            const netlist = generateNetlist(circuit, analysis);

            expect(netlist).toContain('V1');
            expect(netlist).toContain('R1');
            expect(netlist).toContain('C1');
            expect(netlist).toContain('.tran');
            expect(netlist).toContain('.end');
        });

        it('emits a polarized source by pinId (+,-), NOT authored pin order — audit #2, no sign flip', () => {
            const mk = (pins: Array<{ pinId: string; netId: string }>): CircuitJson => ({
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', pins),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vp' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('vp', 'vp'), createNet('0', '0', true)],
            });
            const forward = mk([
                { pinId: '+', netId: 'vp' },
                { pinId: '-', netId: '0' },
            ]);
            const reversed = mk([
                { pinId: '-', netId: '0' },
                { pinId: '+', netId: 'vp' },
            ]);
            const lineOf = (c: CircuitJson) =>
                generateNetlist(c, { type: 'op' } as OpAnalysis)
                    .split('\n')
                    .find((l) => l.startsWith('V1'))!;
            // Authored pin ORDER must not change the emitted card — both bind +→vp, -→0 (canonical).
            expect(lineOf(forward)).toBe(lineOf(reversed));
            // The '+' node precedes the '-' node: ground 0 (the '-' pin) is emitted SECOND, not first.
            const [, nplus, nminus] = lineOf(forward).split(/\s+/);
            expect(nminus).toBe('0');
            expect(nplus).not.toBe('0');
        });

        it('should include title in netlist', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [createNet('vcc', 'vcc'), createNet('0', '0', true)],
            };

            const analysis: TranAnalysis = { type: 'tran', stopTime: '1m' };
            const options: NetlistOptions = { title: 'My Test Circuit' };

            const netlist = generateNetlist(circuit, analysis, options);

            expect(netlist).toContain('My Test Circuit');
        });

        it('should add default diode model when needed', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('D1', 'diode', 'D1', undefined, [
                        { pinId: 'anode', netId: 'vcc' },
                        { pinId: 'cathode', netId: '0' },
                    ]),
                ],
                nets: [createNet('vcc', 'vcc'), createNet('0', '0', true)],
            };

            const analysis: TranAnalysis = { type: 'tran', stopTime: '1m' };

            const netlist = generateNetlist(circuit, analysis);

            expect(netlist).toContain('.model DDEFAULT');
            expect(netlist).toContain('D1');
        });

        it('should include custom probes', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [createNet('vcc', 'vcc'), createNet('0', '0', true)],
            };

            const analysis: TranAnalysis = { type: 'tran', stopTime: '1m' };
            const options: NetlistOptions = { probes: ['v(vcc)', 'i(V1)'] };

            const netlist = generateNetlist(circuit, analysis, options);

            // "vcc" is a reserved word, so its node is sanitized to "x_vcc"; the caller's v(vcc) probe is
            // remapped to v(x_vcc) (else it would resolve to "no such vector" in ngspice).
            expect(netlist).toContain('v(x_vcc)');
            expect(netlist).toContain('i(V1)');
        });

        it('resolves a BARE node-name probe (no v() wrapper) to v(<sanitized node>) — the version-sim path sends bare net ids', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: 'out' },
                    ]),
                    createComponent('R2', 'resistor', 'R2', '1k', [
                        { pinId: '1', netId: 'out' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('out', 'out'), createNet('0', '0', true)],
            };
            // A bare probe (what a UI/API caller naturally sends, e.g. probes:['in','out']) must be wrapped and
            // resolved to v(<sanitized node>), NOT emitted verbatim as `in`/`out` — those aren't ngspice vectors,
            // so wrdata would emit nothing → an opaque "no output file" failure (the exact e2e-dry-run bug).
            // 'in'/'out' are reserved words → sanitized to x_in/x_out.
            const netlist = generateNetlist(circuit, { type: 'tran', stopTime: '1m' }, { probes: ['in', 'out'] });
            const wrdata = netlist.split('\n').find((l) => /wrdata/i.test(l)) ?? '';
            // The probe tokens (after "wrdata output.csv") are exactly the resolved voltage vectors — no bare token.
            expect(wrdata.trim().split(/\s+/).slice(2)).toEqual(['v(x_in)', 'v(x_out)']);
        });

        it('extraProbes ADD a branch-current probe while KEEPING the default node-voltage probes', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'n1' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '300', [
                        { pinId: '1', netId: 'n1' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('n1', 'n1'), createNet('0', '0', true)],
            };

            const netlist = generateNetlist(circuit, { type: 'op' }, { extraProbes: ['i(R1)'] });

            // The current probe is rewritten to the device-current vector + savecurrents is emitted...
            expect(netlist).toContain('@R1[i]');
            expect(netlist).toMatch(/\.options[^\n]*\bsavecurrents\b/);
            // ...AND the auto-generated node-voltage probe is still there (extraProbes ADDS, never replaces).
            expect(netlist).toContain('v(n1)');
        });

        it('extraProbes are IGNORED when an explicit probes override is given', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'n1' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '300', [
                        { pinId: '1', netId: 'n1' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('n1', 'n1'), createNet('0', '0', true)],
            };

            const netlist = generateNetlist(circuit, { type: 'op' }, { probes: ['v(n1)'], extraProbes: ['i(R1)'] });

            expect(netlist).toContain('v(n1)');
            expect(netlist).not.toContain('@R1[i]');
        });

        it('should generate AC analysis command', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'AC 1', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('0', '0', true)],
            };

            const analysis: AcAnalysis = {
                type: 'ac',
                variation: 'dec',
                points: 10,
                startFreq: '1',
                stopFreq: '1MEG',
            };

            const netlist = generateNetlist(circuit, analysis);

            expect(netlist).toContain('.ac dec 10 1 1MEG');
        });

        it('should generate DC analysis command', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 0', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('0', '0', true)],
            };

            const analysis: DcAnalysis = {
                type: 'dc',
                source: 'V1',
                startVal: '0',
                stopVal: '5',
                increment: '0.1',
            };

            const netlist = generateNetlist(circuit, analysis);

            expect(netlist).toContain('.dc V1 0 5 0.1');
        });

        it('should generate OP analysis command', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [createNet('vcc', 'vcc'), createNet('0', '0', true)],
            };

            const analysis: OpAnalysis = { type: 'op' };

            const netlist = generateNetlist(circuit, analysis);

            expect(netlist).toContain('.op');
        });

        it('should include files when specified', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [createNet('vcc', 'vcc'), createNet('0', '0', true)],
            };

            const analysis: TranAnalysis = { type: 'tran', stopTime: '1m' };
            const options: NetlistOptions = {
                includeFiles: ['model.lib'],
                jobDir: '/tmp/job',
            };

            const netlist = generateNetlist(circuit, analysis, options);

            expect(netlist).toContain('.include "model.lib"');
        });

        it('should skip catalog-only generic components without throwing', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vcc' },
                        { pinId: '2', netId: '0' },
                    ]),
                    // A real catalog part with no simulatable model (e.g. an IC): must not break netlisting.
                    {
                        id: 'U1',
                        type: 'generic',
                        designator: 'U1',
                        pins: [
                            { pinId: '1', netId: 'vcc' },
                            { pinId: '2', netId: '0' },
                        ],
                    },
                ],
                nets: [createNet('vcc', 'vcc'), createNet('0', '0', true)],
            };

            const analysis: TranAnalysis = { type: 'tran', stopTime: '1m' };

            expect(() => generateNetlist(circuit, analysis)).not.toThrow();
            const netlist = generateNetlist(circuit, analysis);
            expect(netlist).toContain('R1');
            // U1 is catalog-only → not emitted as a SPICE element line.
            expect(netlist).not.toMatch(/^U1 /m);
        });

        it('throws on an unknown component type instead of silently dropping it', () => {
            // A caller that skips safeValidateCircuitJson could pass a non-existent type (e.g. 'opamp',
            // which is NOT a COMPONENT_TYPE — op-amps are 'generic' + a subckt model). Silently skipping it
            // would yield a degraded netlist that "simulates" to wrong/flat numbers with no error. Fail loud.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    createComponent('U1', 'opamp' as any, 'U1', undefined, [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [createNet('vcc', 'vcc'), createNet('0', '0', true)],
            };
            expect(() => generateNetlist(circuit, { type: 'tran', stopTime: '1m' })).toThrow(
                /Unknown component type 'opamp'/,
            );
        });

        it('points scr/igbt at the subckt+model path in the unknown-type error', () => {
            // scr/igbt are reached as type:'subckt' + model:'SCRGEN'/'IGBTGEN' (the generic models exist),
            // not as first-class types — the reject should say so instead of leaving the caller stuck.
            const scr: CircuitJson = {
                version: '1.0',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                components: [createComponent('SCR1', 'scr' as any, 'SCR1', undefined, [{ pinId: 'a', netId: 'n1' }])],
                nets: [createNet('n1', 'n1'), createNet('0', '0', true)],
            };
            expect(() => generateNetlist(scr, { type: 'op' })).toThrow(/SCRGEN/);
        });

        it('emits validated solver options as a .options card and drops injection attempts', () => {
            // analysis.options tokens land verbatim on a netlist line — each value is re-validated against
            // an anchored numeric pattern; anything else (an injection attempt, a typo'd expression) is
            // silently dropped in favor of ngspice defaults.
            const c: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(c, {
                type: 'tran',
                stopTime: '1m',
                options: {
                    reltol: '0.01',
                    gmin: '1e-9',
                    method: 'gear',
                    itl4: 50,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    abstol: '1e-10; .shell rm -rf' as any, // injection attempt → dropped
                },
            });
            const opt = netlist.split('\n').find((l) => l.startsWith('.options'))!;
            expect(opt).toBe('.options reltol=0.01 gmin=1e-9 method=gear itl4=50');
            expect(netlist).not.toContain('.shell');
            // No options → no .options card at all.
            expect(generateNetlist(c, { type: 'tran', stopTime: '1m' })).not.toContain('.options');
        });

        it('merges solver options with savecurrents on one .options card', () => {
            const c: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(
                c,
                { type: 'tran', stopTime: '1m', options: { reltol: '0.01' } },
                { probes: ['i(R1)'] },
            );
            const opt = netlist.split('\n').find((l) => l.startsWith('.options'))!;
            expect(opt).toBe('.options reltol=0.01 savecurrents');
        });

        it('emits a single-point AC sweep as ".ac lin 1 f f" (dec/oct over one point yields 0 rows)', () => {
            // `.ac dec N f f` makes ngspice run with "No. of Data Rows : 0" and the wrdata fails with a
            // misleading "no such vector" — zero data on a valid request. A one-point sweep must be linear.
            const c: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'AC 1', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('0', '0', true)],
            };
            // identical strings
            expect(
                generateNetlist(c, { type: 'ac', variation: 'dec', points: 10, startFreq: '1k', stopFreq: '1k' }),
            ).toContain('.ac lin 1 1k 1k');
            // equal VALUES spelled differently ('1000' == '1k')
            expect(
                generateNetlist(c, { type: 'ac', variation: 'oct', points: 5, startFreq: '1000', stopFreq: '1k' }),
            ).toContain('.ac lin 1 1000 1k');
            // a real sweep is untouched
            expect(
                generateNetlist(c, { type: 'ac', variation: 'dec', points: 10, startFreq: '1', stopFreq: '1meg' }),
            ).toContain('.ac dec 10 1 1meg');
        });

        it('throws when an AC analysis has no AC-magnitude source (would be all-zero)', () => {
            // A .ac run only excites sources declaring an AC magnitude; with none every probe is identically
            // zero — a meaningless result that would otherwise "succeed". Fail loud.
            const dcOnly: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('0', '0', true)],
            };
            const ac: AcAnalysis = { type: 'ac', variation: 'dec', points: 10, startFreq: '1', stopFreq: '1meg' };
            expect(() => generateNetlist(dcOnly, ac)).toThrow(/AC magnitude/);
            // The same circuit with an AC source is fine.
            dcOnly.components[0]!.value = 'AC 1';
            expect(() => generateNetlist(dcOnly, ac)).not.toThrow();
        });

        it('validates a user-defined subckt instance pin count against its .subckt body port count', () => {
            // A user subckt with only a body (no declared `ports`) binds in authored order, so a wrong pin
            // COUNT silently mis-wires (an unmapped port binds to global node 0 → wrong answer). Fail loud.
            const mk = (pins: { pinId: string; netId: string }[]): CircuitJson => ({
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    { id: 'x1', type: 'subckt', designator: 'X1', model: 'MYBUF', pins },
                ],
                nets: [createNet('in', 'in'), createNet('out', 'out'), createNet('0', '0', true)],
                models: [{ name: 'MYBUF', device: 'subckt', body: '.subckt MYBUF in out gnd\nRb out gnd 1k\n.ends' }],
            });
            // 2 pins against a 3-port body → throw.
            expect(() =>
                generateNetlist(
                    mk([
                        { pinId: 'a', netId: 'in' },
                        { pinId: 'b', netId: 'out' },
                    ]),
                    { type: 'op' },
                ),
            ).toThrow(/declares 3 port/);
            // Correct 3-pin instance → no throw.
            expect(() =>
                generateNetlist(
                    mk([
                        { pinId: 'a', netId: 'in' },
                        { pinId: 'b', netId: 'out' },
                        { pinId: 'c', netId: '0' },
                    ]),
                    { type: 'op' },
                ),
            ).not.toThrow();
        });

        it('throws a clear error when every caller-supplied probe is unobservable (would emit no wrdata)', () => {
            // A sole un-probeable probe (i(D1)/i(Q1) alone, or v(0)) would yield a wrdata-less deck → ngspice
            // exits 0 with no output.csv (opaque empty result). Fail loud naming the bad probes instead.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('D1', 'diode', 'D1', undefined, [
                        { pinId: 'anode', netId: 'in' },
                        { pinId: 'cathode', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('0', '0', true)],
            };
            expect(() => generateNetlist(circuit, { type: 'op' }, { probes: ['i(D1)'] })).toThrow(
                /not observable|i\(D1\)/,
            );
            // A voltage co-probe rescues it (only the diode current is dropped).
            expect(() => generateNetlist(circuit, { type: 'op' }, { probes: ['v(in)', 'i(D1)'] })).not.toThrow();
        });

        it('emits .ic cards for tran initialConditions but does NOT force uic (passes the flag through)', () => {
            // initialConditions is keyed by NET ID; the generator maps each to its sanitized SPICE node and
            // emits `.ic v(<node>)=<v>`. It must NOT force uic — forcing it zeroes supply rails and aborts a
            // self-starting oscillator. `.ic` WITHOUT uic keeps supplies energized (the robust kick idiom);
            // a caller wanting pure-reactive seeding sets uic:true explicitly. Both idioms are asserted below.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vcc' },
                        { pinId: '2', netId: 'cap' },
                    ]),
                    createComponent('C1', 'capacitor', 'C1', '100n', [
                        { pinId: '1', netId: 'cap' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('vcc', 'vcc'), createNet('cap', 'cap'), createNet('0', '0', true)],
            };
            const findTran = (n: string) => n.split('\n').find((l) => l.trim().startsWith('.tran'))!;

            // Default (uic unset): .ic cards present, NO uic on .tran.
            const noUic = generateNetlist(circuit, {
                type: 'tran',
                stopTime: '1m',
                // net 'cap' (reserved-safe) -> node 'ncap'; net '0' (ground) must be skipped (no .ic on ground).
                initialConditions: { cap: 0.1, '0': 0 },
            });
            expect(noUic).toMatch(/^\.ic v\(ncap\)=0\.1$/m);
            expect(noUic).not.toMatch(/\.ic v\(0\)/); // ground is never seeded
            expect(findTran(noUic)).not.toMatch(/\buic\b/); // must NOT force uic

            // Caller opts in (uic:true): .ic cards present AND uic on .tran.
            const withUic = generateNetlist(circuit, {
                type: 'tran',
                stopTime: '1m',
                uic: true,
                initialConditions: { cap: 0.1 },
            });
            expect(withUic).toMatch(/^\.ic v\(ncap\)=0\.1$/m);
            expect(findTran(withUic)).toMatch(/\buic\b/); // caller's flag passes through
        });

        it('emits the correct SPICE device letter when a designator does not match the prefix', () => {
            // SPICE keys a device on its first letter. A Zener's device letter is 'D', but its natural
            // designator is "Z1" — emitting "Z1 …" verbatim is an invalid element (no 'Z' device exists),
            // so the generator must prepend 'D' -> "DZ1". A diode designated "CR1" must become "DCR1"
            // (else it parses as a capacitor). Conventional designators (already starting with the prefix)
            // must pass through UNCHANGED.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('z1', 'zener', 'Z1', '5.1', [
                        { pinId: 'anode', netId: '0' },
                        { pinId: 'cathode', netId: 'in' },
                    ]),
                    createComponent('d1', 'diode', 'CR1', undefined, [
                        { pinId: 'anode', netId: 'in' },
                        { pinId: 'cathode', netId: 'out' },
                    ]),
                    createComponent('d2', 'diode', 'D9', undefined, [
                        { pinId: 'anode', netId: 'out' },
                        { pinId: 'cathode', netId: '0' },
                    ]),
                    createComponent('r1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('out', 'out'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(circuit, { type: 'tran', stopTime: '1m' });
            // Zener: "Z1" -> "DZ1", referencing its generated breakdown model (a real 'D' device).
            const zLine = netlist.split('\n').find((l) => /DZ1\s/i.test(l) && /Z1/i.test(l));
            expect(zLine).toBeTruthy();
            expect(zLine!.startsWith('DZ1')).toBe(true);
            expect(netlist).not.toMatch(/^Z1 /m); // never an invalid bare 'Z' device
            // Diode "CR1" -> "DCR1" (would otherwise parse as a capacitor).
            expect(netlist).toMatch(/^DCR1 /m);
            expect(netlist).not.toMatch(/^CR1 /m);
            // Conventional designators are untouched.
            expect(netlist).toMatch(/^D9 /m);
            expect(netlist).toMatch(/^R1 /m);
        });

        it('remaps i(<designator>) probes to the emitted (prefixed) device name', () => {
            // An inductor designated "FB1" (ferrite-bead convention) emits as "LFB1"; a caller-supplied
            // current probe i(FB1) must be rewritten to i(LFB1) or ngspice reports "i(FB1) not available".
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'a' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('l1', 'inductor', 'FB1', '1u', [
                        { pinId: '1', netId: 'a' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('a', 'a'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(
                circuit,
                { type: 'tran', stopTime: '1m' },
                {
                    probes: ['i(FB1)', 'v(a)', 'i(V1)'],
                },
            );
            expect(netlist).toMatch(/^LFB1 /m); // device emitted prefixed
            expect(netlist).toMatch(/wrdata .*i\(LFB1\)/); // probe remapped to the emitted name
            expect(netlist).not.toMatch(/i\(FB1\)/); // the un-prefixed reference must not survive
            expect(netlist).toMatch(/i\(V1\)/); // conventional designator left as-is
            expect(netlist).toMatch(/v\(na\)/); // node probe v(a) remapped to its sanitized node "na"
        });

        it('rewrites R/C current probes to @dev[i] + savecurrents, keeps native i(V), drops i(diode)', () => {
            // ngspice -b has NO branch-current vector for a resistor/capacitor, so a verbatim i(R1) errors
            // "no such function as i," and aborts the ENTIRE wrdata line — silently killing every co-probe
            // (total data loss). The generator rewrites i(R/C) to the device-current vector @<dev>[i] and
            // emits `.options savecurrents`, leaves native i(V1) untouched, and DROPS i(D1) (the diode's
            // @<dev>[id] vector is mode-finicky — dropping it keeps co-probes alive rather than risk the abort).
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'a' },
                        { pinId: '-', netId: 'b' },
                    ]),
                    createComponent('r1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'b' },
                        { pinId: '2', netId: 'mid' },
                    ]),
                    createComponent('c1', 'capacitor', 'C1', '100n', [
                        { pinId: '1', netId: 'mid' },
                        { pinId: '2', netId: '0' },
                    ]),
                    createComponent('d1', 'diode', 'D1', undefined, [
                        { pinId: 'anode', netId: 'a' },
                        { pinId: 'cathode', netId: 'mid' },
                    ]),
                ],
                nets: [createNet('a', 'a'), createNet('b', 'b'), createNet('mid', 'mid'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(
                circuit,
                { type: 'tran', stopTime: '1m' },
                {
                    probes: ['v(mid)', 'i(R1)', 'i(C1)', 'i(D1)', 'i(V1)'],
                },
            );
            const wr = netlist.split('\n').find((l) => l.includes('wrdata'))!;
            expect(netlist).toMatch(/^\.options savecurrents$/m); // emitted once because R/C currents are probed
            expect(wr).toMatch(/@R1\[i\]/); // resistor current via the device-current vector
            expect(wr).toMatch(/@C1\[i\]/); // capacitor current
            expect(wr).toMatch(/i\(V1\)/); // voltage source keeps its NATIVE branch current
            expect(wr).toMatch(/v\(nmid\)/); // the voltage co-probe survives on the same line
            // No bare i(R1)/i(C1) survives to abort the line; the diode current probe is dropped entirely.
            expect(wr).not.toMatch(/\bi\(R1\)/);
            expect(wr).not.toMatch(/\bi\(C1\)/);
            expect(wr).not.toMatch(/\bi\(D1\)/);
            expect(wr).not.toMatch(/@D1\[/); // diode dropped, NOT rewritten (its @-vector is mode-finicky)
        });

        it('drops a current probe on a multi-terminal device instead of aborting the wrdata line', () => {
            // A BJT has no single branch-current vector (ic/ib/ie), so i(Q1) is unresolvable and would abort
            // the whole wrdata line. It must be DROPPED so the voltage co-probe still produces output. No
            // savecurrents is needed when only native + dropped probes remain.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('rc', 'resistor', 'RC', '1k', [
                        { pinId: '1', netId: 'vcc' },
                        { pinId: '2', netId: 'col' },
                    ]),
                    {
                        id: 'q1',
                        type: 'bjt',
                        designator: 'Q1',
                        model: 'QGENNPN',
                        pins: [
                            { pinId: 'c', netId: 'col' },
                            { pinId: 'b', netId: 'vcc' },
                            { pinId: 'e', netId: '0' },
                        ],
                    },
                ],
                nets: [createNet('vcc', 'vcc'), createNet('col', 'col'), createNet('0', '0', true)],
                models: [{ name: 'QGENNPN', device: 'bjt', body: '.model QGENNPN NPN(BF=100)' }],
            };
            const netlist = generateNetlist(
                circuit,
                { type: 'tran', stopTime: '1m' },
                {
                    probes: ['v(col)', 'i(Q1)'],
                },
            );
            const wr = netlist.split('\n').find((l) => l.includes('wrdata'))!;
            expect(wr).toMatch(/v\(ncol\)/); // co-probe survives
            expect(wr).not.toMatch(/i\(Q1\)/); // ambiguous transistor current dropped
            expect(wr).not.toMatch(/@Q1\[/); // and NOT rewritten to a @-vector (no single current)
            expect(netlist).not.toMatch(/savecurrents/); // not needed when nothing was rewritten to @dev[i]
        });

        it('drops R/C current probes in AC (their @dev[i] vector is unresolvable there) but keeps voltage co-probes', () => {
            // @<dev>[i] resolves in op/dc/tran but NOT in AC — ngspice errors "no such vector @R1[i]" and the
            // bad token aborts the whole shared wrdata line, losing every co-probe. So R/C current probes must
            // be DROPPED in AC, while the SAME probes are rewritten to @dev[i] in tran.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'AC 1', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1.6k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: 'out' },
                    ]),
                    createComponent('C1', 'capacitor', 'C1', '100n', [
                        { pinId: '1', netId: 'out' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('out', 'out'), createNet('0', '0', true)],
            };
            const ac: AcAnalysis = { type: 'ac', variation: 'dec', points: 10, startFreq: '1', stopFreq: '1meg' };
            const acNet = generateNetlist(circuit, ac, { probes: ['v(out)', 'i(R1)', 'i(C1)'] });
            const wr = acNet.split('\n').find((l) => l.includes('wrdata'))!;
            expect(wr).toMatch(/v\(x_out\)/); // voltage co-probe survives
            expect(wr).not.toMatch(/@R1\[i\]/); // R current dropped in AC
            expect(wr).not.toMatch(/@C1\[i\]/); // C current dropped in AC
            expect(acNet).not.toMatch(/savecurrents/); // not emitted when both R/C probes were dropped
            // Control: the SAME probes in tran ARE rewritten to the device-current vector.
            const tranNet = generateNetlist(
                circuit,
                { type: 'tran', stopTime: '1m' },
                { probes: ['v(out)', 'i(R1)', 'i(C1)'] },
            );
            expect(tranNet).toMatch(/@R1\[i\]/);
            expect(tranNet).toMatch(/@C1\[i\]/);
        });

        it('emits a diode in canonical anode→cathode order regardless of authored pin-array order', () => {
            // A diode is POLARIZED. The authored pin-ARRAY order must not flip it — pinIds name the terminals.
            // Here pins are listed cathode-FIRST (pinIds correct: anode→out, cathode→0); the emitted line must
            // still be "D1 <anode> <cathode>" = "D1 x_out 0", not the reversed "D1 0 x_out".
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: 'out' },
                    ]),
                    createComponent('D1', 'diode', 'D1', undefined, [
                        { pinId: 'cathode', netId: '0' },
                        { pinId: 'anode', netId: 'out' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('out', 'out'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(circuit, { type: 'op' });
            const dline = netlist.split('\n').find((l) => /^D1 /.test(l))!;
            expect(dline).toMatch(/^D1 x_out 0 /); // anode (out→x_out) BEFORE cathode (0)
        });

        it('collapses internal whitespace in a passive value so "1 k" / "100 nF" still emit a valid card', () => {
            // SPICE tokenizes on whitespace; a passive value is a single magnitude token, so a stray space
            // ('1 k') would shift 'k' into an extra column and break the deck. R/C/L values are normalized.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 10', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1 k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: 'mid' },
                    ]),
                    createComponent('C1', 'capacitor', 'C1', '100 nF', [
                        { pinId: '1', netId: 'mid' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('mid', 'mid'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(circuit, { type: 'op' });
            expect(netlist).toMatch(/^R1 \S+ \S+ 1k$/m); // "1 k" -> "1k", one trailing token
            expect(netlist).toMatch(/^C1 \S+ \S+ 100nF$/m); // "100 nF" -> "100nF"
            // A source value keeps its legitimate internal spaces (NOT normalized).
            expect(netlist).toMatch(/^V1 \S+ \S+ DC 10$/m);
        });

        it('uses the transformer windingResistance property for winding DCR, defaulting to 1m', () => {
            // Default winding DCR is a tiny 1mΩ (anti-singularity); a caller modeling a real transformer can
            // set `windingResistance` for faithful magnetizing settling (the 1mΩ default gives a huge L/R
            // time constant on high-L windings). Default must stay 1m (zero regression for existing circuits).
            const mk = (props: Record<string, unknown>): CircuitJson => ({
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'SIN(0 10 50)', [
                        { pinId: '+', netId: 'pri' },
                        { pinId: '-', netId: '0' },
                    ]),
                    {
                        id: 'T1',
                        type: 'transformer',
                        designator: 'T1',
                        properties: props,
                        pins: [
                            { pinId: 'p+', netId: 'pri' },
                            { pinId: 'p-', netId: '0' },
                            { pinId: 's+', netId: 'sec' },
                            { pinId: 's-', netId: '0' },
                        ],
                    },
                    createComponent('RL', 'resistor', 'RL', '1k', [
                        { pinId: '1', netId: 'sec' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('pri', 'pri'), createNet('sec', 'sec'), createNet('0', '0', true)],
            });
            const base = { primaryInductance: '1', secondaryInductance: '4', coupling: '0.95' };
            const def = generateNetlist(mk(base), { type: 'tran', stopTime: '20m' });
            expect(def).toMatch(/^RT1P \S+ \S+ 1m$/m); // default DCR unchanged
            expect(def).toMatch(/^RT1S \S+ \S+ 1m$/m);
            const custom = generateNetlist(mk({ ...base, windingResistance: '5' }), { type: 'tran', stopTime: '20m' });
            expect(custom).toMatch(/^RT1P \S+ \S+ 5$/m); // caller-set DCR honored
            expect(custom).toMatch(/^RT1S \S+ \S+ 5$/m);
        });

        it('remaps a .dc sweep source to the emitted (prefixed) device name', () => {
            // A voltage source designated "BAT1" emits as "VBAT1"; the sweep card must name VBAT1, not
            // BAT1, else ngspice aborts with "BAT1 is not in the circuit".
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'BAT1', 'DC 0', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('r1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('0', '0', true)],
            };
            const dc: DcAnalysis = { type: 'dc', source: 'BAT1', startVal: '0', stopVal: '5', increment: '1' };
            const netlist = generateNetlist(circuit, dc);
            expect(netlist).toMatch(/^VBAT1 /m); // device emitted prefixed
            expect(netlist).toMatch(/^\.dc VBAT1 /m); // sweep references the emitted name
            expect(netlist).not.toMatch(/\.dc BAT1 /m);
        });

        it('throws on case-insensitive duplicate device names (ngspice is case-insensitive)', () => {
            // "d1" and "D1" are distinct strings but the same ngspice device — must be caught at generation
            // with a clear error, not leak to ngspice's opaque "device already exists, bail out".
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'V1', 'DC 1', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('d1', 'diode', 'd1', undefined, [
                        { pinId: 'anode', netId: 'in' },
                        { pinId: 'cathode', netId: 'mid' },
                    ]),
                    createComponent('d2', 'diode', 'D1', undefined, [
                        { pinId: 'anode', netId: 'mid' },
                        { pinId: 'cathode', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('mid', 'mid'), createNet('0', '0', true)],
            };
            expect(() => generateNetlist(circuit, { type: 'tran', stopTime: '1m' })).toThrow(
                /[Dd]uplicate device name/,
            );
        });

        it('remaps caller-supplied v(<net>) probes to the sanitized node (id, name, reserved word, differential)', () => {
            // A caller writes v(rail)/v(out) using the circuit's net id, but ngspice only knows the
            // sanitized node ("rail"->"nrail", reserved "out"->"x_out"). The probe must be remapped, or it
            // resolves to "no such vector". Differential v(a,b) and a probe already using the node are also
            // handled. (i(...) and unknown args are left untouched.)
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'rail' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('r1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'rail' },
                        { pinId: '2', netId: 'out' },
                    ]),
                    createComponent('r2', 'resistor', 'R2', '1k', [
                        { pinId: '1', netId: 'out' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('rail', 'rail'), createNet('out', 'out'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(
                circuit,
                { type: 'tran', stopTime: '1m' },
                {
                    probes: ['v(rail)', 'v(out)', 'v(rail,out)', 'v(nrail)', 'i(V1)'],
                },
            );
            const wr = netlist.split('\n').find((l) => l.includes('wrdata'))!;
            expect(wr).toContain('v(nrail)'); // net id "rail" -> node "nrail"
            expect(wr).toContain('v(x_out)'); // reserved-word net "out" -> node "x_out"
            expect(wr).toContain('v(nrail,x_out)'); // differential, both args remapped
            expect(wr).toContain('i(V1)'); // current probe untouched here
            expect(wr).not.toMatch(/v\(rail\)/); // raw net id must not survive
            expect(wr).not.toMatch(/v\(out\)/);
        });

        it('drops ground from probes (ngspice has no v(0)); v(node,gnd) reduces to v(node)', () => {
            // Ground is the implicit reference: v(0)/v(node,0) errors with "no such vector 0" and aborts the
            // ENTIRE wrdata. So a ground arg is dropped — v(out,gnd)->v(out) — and a pure-ground probe is
            // omitted, while every other probe on the line survives.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'V1', 'DC 8', [
                        { pinId: '+', netId: 'out' },
                        { pinId: '-', netId: 'gnd' },
                    ]),
                    createComponent('r1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'out' },
                        { pinId: '2', netId: 'mid' },
                    ]),
                    createComponent('r2', 'resistor', 'R2', '1k', [
                        { pinId: '1', netId: 'mid' },
                        { pinId: '2', netId: 'gnd' },
                    ]),
                ],
                nets: [createNet('out', 'out'), createNet('mid', 'mid'), createNet('gnd', 'gnd', true)],
            };
            const netlist = generateNetlist(
                circuit,
                { type: 'tran', stopTime: '1m' },
                {
                    probes: ['v(mid)', 'v(out,gnd)', 'v(gnd)'],
                },
            );
            const wr = netlist.split('\n').find((l) => l.includes('wrdata'))!;
            expect(wr).toContain('v(nmid)'); // ordinary probe kept
            expect(wr).toContain('v(x_out)'); // v(out,gnd) reduced to single-ended v(out)->v(x_out)
            expect(wr).not.toMatch(/,\s*0\)/); // no v(...,0) differential-against-ground
            expect(wr).not.toMatch(/v\(0\)/); // no scalar v(0)
            expect(wr).not.toMatch(/v\(gnd\)/); // pure-ground probe dropped entirely
        });

        it('strips token-breaking characters from a designator (no phantom node)', () => {
            // "C 1" would otherwise emit `C 1 <n1> <n2> 100n`, parsed as device C wired to a phantom node
            // "1"; sanitization yields a single-token "C1".
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'V1', 'DC 1', [
                        { pinId: '+', netId: 'a' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('c1', 'capacitor', 'C 1', '100n', [
                        { pinId: '1', netId: 'a' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('a', 'a'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(circuit, { type: 'tran', stopTime: '1m' });
            expect(netlist).toMatch(/^C1 na 0 100n$/m); // single token, correct nodes
            expect(netlist).not.toMatch(/^C 1 /m);
        });
    });

    describe('isSimulatable', () => {
        it('is false for catalog-only generic parts, true for SPICE primitives', () => {
            expect(isSimulatable({ type: 'generic' })).toBe(false);
            expect(isSimulatable({ type: 'resistor' })).toBe(true);
            expect(isSimulatable({ type: 'diode' })).toBe(true);
            expect(isSimulatable({ type: 'voltage_source' })).toBe(true);
        });
    });

    describe('getNodeNames', () => {
        it('should return all node names', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [],
                nets: [createNet('vcc', 'vcc'), createNet('out', 'out'), createNet('0', '0', true)],
            };

            const nodes = getNodeNames(circuit);

            expect(nodes).toContain('0');
            expect(nodes.length).toBe(3);
        });
    });

    describe('validateNetlist', () => {
        it('should validate a correct netlist', () => {
            const netlist = `* Test
V1 in 0 DC 5
R1 in out 1k
.tran 1u 1m
.end`;

            const result = validateNetlist(netlist);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should detect missing .end', () => {
            const netlist = `* Test
V1 in 0 DC 5
.tran 1u 1m`;

            const result = validateNetlist(netlist);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes('.end'))).toBe(true);
        });

        it('should detect missing analysis', () => {
            const netlist = `* Test
V1 in 0 DC 5
.end`;

            const result = validateNetlist(netlist);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes('analysis'))).toBe(true);
        });
    });
});
