import { PrismaClient, OrgRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';

// This script runs standalone via ts-node (outside Nest's ConfigModule), so load the
// monorepo root .env ourselves. In Docker/CI env vars are injected directly (file absent).
try {
    const envPath = resolve(process.cwd(), '../../.env');
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (m) {
            const key = m[1]!;
            if (!process.env[key]) process.env[key] = (m[2] ?? '').replace(/^["']|["']$/g, '');
        }
    }
} catch {
    /* no root .env (e.g. Docker) — rely on injected env */
}

const prisma = new PrismaClient();

// Demo circuit templates
const templates = [
    {
        name: 'RC Low-Pass Filter',
        description: 'Simple first-order RC low-pass filter',
        tags: ['filter', 'analog', 'beginner', 'rc'],
        circuitJson: {
            version: '1.0',
            components: [
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '10k',
                    pins: [
                        { pinId: '1', netId: 'input' },
                        { pinId: '2', netId: 'output' },
                    ],
                },
                {
                    id: 'c1',
                    type: 'capacitor',
                    designator: 'C1',
                    value: '100n',
                    pins: [
                        { pinId: '1', netId: 'output' },
                        { pinId: '2', netId: 'gnd' },
                    ],
                },
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: 'DC 5',
                    pins: [
                        { pinId: '+', netId: 'input' },
                        { pinId: '-', netId: 'gnd' },
                    ],
                },
                {
                    id: 'gnd1',
                    type: 'ground',
                    designator: 'GND1',
                    pins: [{ pinId: '1', netId: 'gnd' }],
                },
            ],
            nets: [
                { id: 'input', name: 'INPUT' },
                { id: 'output', name: 'OUTPUT' },
                { id: 'gnd', name: 'GND', isGround: true },
            ],
            metadata: {
                name: 'RC Low-Pass Filter',
                description: 'Cutoff frequency: 159 Hz',
            },
        },
    },
    {
        name: 'Voltage Divider',
        description: 'Basic resistor voltage divider',
        tags: ['beginner', 'resistor', 'basic'],
        circuitJson: {
            version: '1.0',
            components: [
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '10k',
                    pins: [
                        { pinId: '1', netId: 'vin' },
                        { pinId: '2', netId: 'vout' },
                    ],
                },
                {
                    id: 'r2',
                    type: 'resistor',
                    designator: 'R2',
                    value: '10k',
                    pins: [
                        { pinId: '1', netId: 'vout' },
                        { pinId: '2', netId: 'gnd' },
                    ],
                },
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: 'DC 10',
                    pins: [
                        { pinId: '+', netId: 'vin' },
                        { pinId: '-', netId: 'gnd' },
                    ],
                },
                {
                    id: 'gnd1',
                    type: 'ground',
                    designator: 'GND1',
                    pins: [{ pinId: '1', netId: 'gnd' }],
                },
            ],
            nets: [
                { id: 'vin', name: 'VIN' },
                { id: 'vout', name: 'VOUT' },
                { id: 'gnd', name: 'GND', isGround: true },
            ],
            metadata: {
                name: 'Voltage Divider',
                description: 'Output: 5V (half of input)',
            },
        },
    },
    {
        name: 'Diode Rectifier',
        description: 'Half-wave rectifier with diode',
        tags: ['diode', 'rectifier', 'power'],
        circuitJson: {
            version: '1.0',
            components: [
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: 'SIN(0 5 1k)',
                    pins: [
                        { pinId: '+', netId: 'ac_in' },
                        { pinId: '-', netId: 'gnd' },
                    ],
                },
                {
                    id: 'd1',
                    type: 'diode',
                    designator: 'D1',
                    pins: [
                        { pinId: 'anode', netId: 'ac_in' },
                        { pinId: 'cathode', netId: 'dc_out' },
                    ],
                },
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '1k',
                    pins: [
                        { pinId: '1', netId: 'dc_out' },
                        { pinId: '2', netId: 'gnd' },
                    ],
                },
                {
                    id: 'gnd1',
                    type: 'ground',
                    designator: 'GND1',
                    pins: [{ pinId: '1', netId: 'gnd' }],
                },
            ],
            nets: [
                { id: 'ac_in', name: 'AC_IN' },
                { id: 'dc_out', name: 'DC_OUT' },
                { id: 'gnd', name: 'GND', isGround: true },
            ],
            metadata: {
                name: 'Diode Rectifier',
                description: 'Half-wave rectifier, 1kHz AC input',
            },
        },
    },
    {
        name: 'LC Oscillator',
        description: 'Basic LC tank circuit',
        tags: ['oscillator', 'lc', 'resonance'],
        circuitJson: {
            version: '1.0',
            components: [
                {
                    id: 'l1',
                    type: 'inductor',
                    designator: 'L1',
                    value: '10m',
                    pins: [
                        { pinId: '1', netId: 'tank' },
                        { pinId: '2', netId: 'gnd' },
                    ],
                },
                {
                    id: 'c1',
                    type: 'capacitor',
                    designator: 'C1',
                    value: '100n',
                    pins: [
                        { pinId: '1', netId: 'tank' },
                        { pinId: '2', netId: 'gnd' },
                    ],
                },
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: 'PULSE(0 5 0 1n 1n 1u 1)',
                    pins: [
                        { pinId: '+', netId: 'tank' },
                        { pinId: '-', netId: 'gnd' },
                    ],
                },
                {
                    id: 'gnd1',
                    type: 'ground',
                    designator: 'GND1',
                    pins: [{ pinId: '1', netId: 'gnd' }],
                },
            ],
            nets: [
                { id: 'tank', name: 'TANK' },
                { id: 'gnd', name: 'GND', isGround: true },
            ],
            metadata: {
                name: 'LC Oscillator',
                description: 'Resonant frequency: ~5 kHz',
            },
        },
    },
    {
        name: 'RC Integrator',
        description: 'RC integrator circuit',
        tags: ['integrator', 'rc', 'analog'],
        circuitJson: {
            version: '1.0',
            components: [
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '10k',
                    pins: [
                        { pinId: '1', netId: 'input' },
                        { pinId: '2', netId: 'output' },
                    ],
                },
                {
                    id: 'c1',
                    type: 'capacitor',
                    designator: 'C1',
                    value: '1u',
                    pins: [
                        { pinId: '1', netId: 'output' },
                        { pinId: '2', netId: 'gnd' },
                    ],
                },
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: 'PULSE(0 5 0 1n 1n 5m 10m)',
                    pins: [
                        { pinId: '+', netId: 'input' },
                        { pinId: '-', netId: 'gnd' },
                    ],
                },
                {
                    id: 'gnd1',
                    type: 'ground',
                    designator: 'GND1',
                    pins: [{ pinId: '1', netId: 'gnd' }],
                },
            ],
            nets: [
                { id: 'input', name: 'INPUT' },
                { id: 'output', name: 'OUTPUT' },
                { id: 'gnd', name: 'GND', isGround: true },
            ],
            metadata: {
                name: 'RC Integrator',
                description: 'Time constant: 10ms',
            },
        },
    },
    {
        name: 'Buck Converter (12V → ~5.5V)',
        description: 'Step-down switching converter: 12V input, 100kHz/50% PWM-driven switch, freewheel power diode + LC filter into a 10Ω load. Run a ~3ms transient to watch it settle to ~5.5V. (Validated on ngspice: 5.50V, ~0.11V ripple.)',
        tags: ['power', 'smps', 'buck', 'switching', 'intermediate'],
        circuitJson: {
            version: '1.0',
            components: [
                { id: 'vin', type: 'voltage_source', designator: 'V1', value: 'DC 12', pins: [{ pinId: '+', netId: 'vin' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'vpwm', type: 'voltage_source', designator: 'V2', value: 'PULSE(0 5 0 10n 10n 5u 10u)', pins: [{ pinId: '+', netId: 'pwm' }, { pinId: '-', netId: 'gnd' }] },
                { id: 's1', type: 'switch', designator: 'S1', model: 'SWGEN', pins: [{ pinId: '+', netId: 'vin' }, { pinId: '-', netId: 'sw' }, { pinId: 'c+', netId: 'pwm' }, { pinId: 'c-', netId: 'gnd' }] },
                { id: 'd1', type: 'diode', designator: 'D1', model: 'DPWR', pins: [{ pinId: 'anode', netId: 'gnd' }, { pinId: 'cathode', netId: 'sw' }] },
                { id: 'l1', type: 'inductor', designator: 'L1', value: '220u', pins: [{ pinId: '1', netId: 'sw' }, { pinId: '2', netId: 'out' }] },
                { id: 'c1', type: 'capacitor', designator: 'C1', value: '220u', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
                { id: 'rl', type: 'resistor', designator: 'R1', value: '10', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
                { id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
            ],
            nets: [
                { id: 'vin', name: 'VIN' }, { id: 'pwm', name: 'PWM' }, { id: 'sw', name: 'SW' },
                { id: 'out', name: 'OUT' }, { id: 'gnd', name: 'GND', isGround: true },
            ],
            models: [
                { name: 'SWGEN', device: 'switch', tier: 'generic', body: '.model SWGEN SW(VT=2.5 VH=0.5 RON=1 ROFF=1Meg)' },
                { name: 'DPWR', device: 'diode', tier: 'generic', body: '.model DPWR D(IS=1e-10 N=1 RS=0.01 BV=100 IBV=1m)' },
            ],
            metadata: { name: 'Buck Converter', description: '12V → ~5.5V at 50% duty, 100kHz' },
        },
    },
    {
        name: 'Sallen-Key Low-Pass Filter (~1kHz)',
        description: '2nd-order unity-gain Sallen-Key active low-pass (op-amp), cutoff ≈1kHz, 40dB/decade rolloff. Run a transient with the built-in 200Hz source to see the passband, or sweep the source frequency. (Validated: unity passband gain.)',
        tags: ['filter', 'active', 'opamp', 'sallen-key', 'analog', 'intermediate'],
        circuitJson: {
            version: '1.0',
            components: [
                { id: 'vin', type: 'voltage_source', designator: 'V1', value: 'SIN(0 1 200)', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'r1', type: 'resistor', designator: 'R1', value: '10k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'na' }] },
                { id: 'r2', type: 'resistor', designator: 'R2', value: '10k', pins: [{ pinId: '1', netId: 'na' }, { pinId: '2', netId: 'np' }] },
                { id: 'c1', type: 'capacitor', designator: 'C1', value: '22n', pins: [{ pinId: '1', netId: 'na' }, { pinId: '2', netId: 'out' }] },
                { id: 'c2', type: 'capacitor', designator: 'C2', value: '10n', pins: [{ pinId: '1', netId: 'np' }, { pinId: '2', netId: 'gnd' }] },
                { id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: 'out' }, { pinId: 'in+', netId: 'np' }, { pinId: 'in-', netId: 'out' }, { pinId: 'vcc', netId: 'vcc' }, { pinId: 'vee', netId: 'vee' }] },
                { id: 'vcc', type: 'voltage_source', designator: 'VCC1', value: 'DC 15', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'vee', type: 'voltage_source', designator: 'VEE1', value: 'DC -15', pins: [{ pinId: '+', netId: 'vee' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
            ],
            nets: [
                { id: 'in', name: 'IN' }, { id: 'na', name: 'NA' }, { id: 'np', name: 'NP' }, { id: 'out', name: 'OUT' },
                { id: 'vcc', name: 'VCC' }, { id: 'vee', name: 'VEE' }, { id: 'gnd', name: 'GND', isGround: true },
            ],
            models: [
                { name: 'OPAMPGEN', device: 'subckt', tier: 'generic', ports: ['out', 'in+', 'in-', 'vcc', 'vee'], body: '.subckt OPAMPGEN out inp inn vcc vee\nRin   inp inn 2Meg\nGm    0 n2 inp inn 1e-3\nRpole n2 0 1e8\nCp    n2 0 16p\nDhi   n2 vcc DCLMP\nDlo   vee n2 DCLMP\nEbuf  n3 0 n2 0 1\nRout  n3 out 50\n.model DCLMP D(IS=1e-12 N=1)\n.ends' },
            ],
            metadata: { name: 'Sallen-Key Low-Pass', description: '2nd-order, fc ≈ 1kHz, unity gain' },
        },
    },
    {
        name: '555-style Astable Oscillator (~1kHz)',
        description: 'Square-wave relaxation oscillator (op-amp comparator + RC, the 555 astable function), self-starting, ~1.1kHz, rail-to-rail. Run a transient (≥5ms) to see the oscillation. (Validated: ~1.1kHz, ±15V.)',
        tags: ['oscillator', 'astable', '555', 'opamp', 'timer', 'intermediate'],
        circuitJson: {
            version: '1.0',
            components: [
                { id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: 'out' }, { pinId: 'in+', netId: 'np' }, { pinId: 'in-', netId: 'cap' }, { pinId: 'vcc', netId: 'vcc' }, { pinId: 'vee', netId: 'vee' }] },
                { id: 'rf', type: 'resistor', designator: 'R1', value: '10k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'np' }] },
                { id: 'rg', type: 'resistor', designator: 'R2', value: '10k', pins: [{ pinId: '1', netId: 'np' }, { pinId: '2', netId: 'gnd' }] },
                { id: 'rstart', type: 'resistor', designator: 'R4', value: '1Meg', pins: [{ pinId: '1', netId: 'np' }, { pinId: '2', netId: 'vcc' }] },
                { id: 'rt', type: 'resistor', designator: 'R3', value: '10k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'cap' }] },
                { id: 'ct', type: 'capacitor', designator: 'C1', value: '47n', pins: [{ pinId: '1', netId: 'cap' }, { pinId: '2', netId: 'gnd' }] },
                { id: 'vcc', type: 'voltage_source', designator: 'VCC1', value: 'DC 15', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'vee', type: 'voltage_source', designator: 'VEE1', value: 'DC -15', pins: [{ pinId: '+', netId: 'vee' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
            ],
            nets: [
                { id: 'out', name: 'OUT' }, { id: 'np', name: 'NP' }, { id: 'cap', name: 'CAP' },
                { id: 'vcc', name: 'VCC' }, { id: 'vee', name: 'VEE' }, { id: 'gnd', name: 'GND', isGround: true },
            ],
            models: [
                { name: 'OPAMPGEN', device: 'subckt', tier: 'generic', ports: ['out', 'in+', 'in-', 'vcc', 'vee'], body: '.subckt OPAMPGEN out inp inn vcc vee\nRin   inp inn 2Meg\nGm    0 n2 inp inn 1e-3\nRpole n2 0 1e8\nCp    n2 0 16p\nDhi   n2 vcc DCLMP\nDlo   vee n2 DCLMP\nEbuf  n3 0 n2 0 1\nRout  n3 out 50\n.model DCLMP D(IS=1e-12 N=1)\n.ends' },
            ],
            metadata: { name: '555-style Astable', description: '~1.1kHz square-wave relaxation oscillator' },
        },
    },
    {
        name: 'Class-AB Push-Pull Output Stage',
        description: 'Complementary NPN/PNP emitter-follower output stage with diode bias to minimize crossover distortion. ±15V rails, 1kHz input → the output follows the input into the load. (Validated: ~9.9Vpp follower.)',
        tags: ['amplifier', 'class-ab', 'push-pull', 'transistor', 'analog', 'intermediate'],
        circuitJson: {
            version: '1.0',
            components: [
                { id: 'vin', type: 'voltage_source', designator: 'V1', value: 'SIN(0 5 1k)', pins: [{ pinId: '+', netId: 'mid' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'r1', type: 'resistor', designator: 'R1', value: '4.7k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'bn' }] },
                { id: 'd1', type: 'diode', designator: 'D1', pins: [{ pinId: 'anode', netId: 'bn' }, { pinId: 'cathode', netId: 'mid' }] },
                { id: 'd2', type: 'diode', designator: 'D2', pins: [{ pinId: 'anode', netId: 'mid' }, { pinId: 'cathode', netId: 'bp' }] },
                { id: 'r2', type: 'resistor', designator: 'R2', value: '4.7k', pins: [{ pinId: '1', netId: 'bp' }, { pinId: '2', netId: 'vee' }] },
                { id: 'q1', type: 'bjt', designator: 'Q1', model: 'QGENNPN', pins: [{ pinId: 'c', netId: 'vcc' }, { pinId: 'b', netId: 'bn' }, { pinId: 'e', netId: 'out' }] },
                { id: 'q2', type: 'bjt', designator: 'Q2', model: 'QGENPNP', pins: [{ pinId: 'c', netId: 'vee' }, { pinId: 'b', netId: 'bp' }, { pinId: 'e', netId: 'out' }] },
                { id: 'rl', type: 'resistor', designator: 'RL1', value: '1k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
                { id: 'vcc', type: 'voltage_source', designator: 'VCC1', value: 'DC 15', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'vee', type: 'voltage_source', designator: 'VEE1', value: 'DC -15', pins: [{ pinId: '+', netId: 'vee' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
            ],
            nets: [
                { id: 'mid', name: 'MID' }, { id: 'bn', name: 'BN' }, { id: 'bp', name: 'BP' }, { id: 'out', name: 'OUT' },
                { id: 'vcc', name: 'VCC' }, { id: 'vee', name: 'VEE' }, { id: 'gnd', name: 'GND', isGround: true },
            ],
            models: [
                { name: 'QGENNPN', device: 'bjt', tier: 'generic', body: '.model QGENNPN NPN(IS=10f BF=200 VAF=100 IKF=0.3 ISE=1p NE=1.5 RB=10 RC=1 RE=0.5 CJE=8p CJC=4p TF=0.4n TR=50n)' },
                { name: 'QGENPNP', device: 'bjt', tier: 'generic', body: '.model QGENPNP PNP(IS=10f BF=180 VAF=100 IKF=0.2 ISE=1p NE=1.5 RB=10 RC=1 RE=0.5 CJE=10p CJC=6p TF=0.6n TR=80n)' },
            ],
            metadata: { name: 'Class-AB Push-Pull', description: 'Complementary follower, ±15V, low crossover' },
        },
    },
    {
        name: 'R-2R Ladder DAC (4-bit)',
        description: '4-bit resistor-ladder digital-to-analog converter. The 4 bit sources (here set to 1010 = decimal 10) produce a weighted analog output. Run an operating-point (op) analysis: Vout = Vref·code/16 = 5·10/16 = 3.125V. (Validated: 3.125V exact.)',
        tags: ['dac', 'r-2r', 'ladder', 'data-converter', 'intermediate'],
        circuitJson: {
            version: '1.0',
            components: [
                { id: 'b0', type: 'voltage_source', designator: 'VB0', value: 'DC 0', pins: [{ pinId: '+', netId: 'b0' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'b1', type: 'voltage_source', designator: 'VB1', value: 'DC 5', pins: [{ pinId: '+', netId: 'b1' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'b2', type: 'voltage_source', designator: 'VB2', value: 'DC 0', pins: [{ pinId: '+', netId: 'b2' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'b3', type: 'voltage_source', designator: 'VB3', value: 'DC 5', pins: [{ pinId: '+', netId: 'b3' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'rterm', type: 'resistor', designator: 'R0', value: '20k', pins: [{ pinId: '1', netId: 'n0' }, { pinId: '2', netId: 'gnd' }] },
                { id: 'r2_0', type: 'resistor', designator: 'R20', value: '20k', pins: [{ pinId: '1', netId: 'b0' }, { pinId: '2', netId: 'n0' }] },
                { id: 'r01', type: 'resistor', designator: 'R10', value: '10k', pins: [{ pinId: '1', netId: 'n0' }, { pinId: '2', netId: 'n1' }] },
                { id: 'r2_1', type: 'resistor', designator: 'R21', value: '20k', pins: [{ pinId: '1', netId: 'b1' }, { pinId: '2', netId: 'n1' }] },
                { id: 'r12', type: 'resistor', designator: 'R11', value: '10k', pins: [{ pinId: '1', netId: 'n1' }, { pinId: '2', netId: 'n2' }] },
                { id: 'r2_2', type: 'resistor', designator: 'R22', value: '20k', pins: [{ pinId: '1', netId: 'b2' }, { pinId: '2', netId: 'n2' }] },
                { id: 'r23', type: 'resistor', designator: 'R12', value: '10k', pins: [{ pinId: '1', netId: 'n2' }, { pinId: '2', netId: 'out' }] },
                { id: 'r2_3', type: 'resistor', designator: 'R23', value: '20k', pins: [{ pinId: '1', netId: 'b3' }, { pinId: '2', netId: 'out' }] },
                { id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
            ],
            nets: [
                { id: 'b0', name: 'B0' }, { id: 'b1', name: 'B1' }, { id: 'b2', name: 'B2' }, { id: 'b3', name: 'B3' },
                { id: 'n0', name: 'N0' }, { id: 'n1', name: 'N1' }, { id: 'n2', name: 'N2' },
                { id: 'out', name: 'OUT' }, { id: 'gnd', name: 'GND', isGround: true },
            ],
            metadata: { name: 'R-2R Ladder DAC', description: '4-bit, Vout = Vref·code/16' },
        },
    },
];

/**
 * Flagship / large demo circuits (the 100+ component ones — ALU, DDS, amplifier, …) live as JSON files in
 * ./templates rather than inline here, because of their size. Each file is { name, description, tags,
 * circuitJson } and was ngspice-validated before being committed. Loaded + upserted alongside the inline set.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadFileTemplates(): any[] {
    const dir = resolve(__dirname, 'templates');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')));
}

async function main(): Promise<void> {
    console.log('🌱 Starting database seed...');

    // Create demo user
    const passwordHash = await argon2.hash('demo123456');

    const user = await prisma.user.upsert({
        where: { email: 'demo@circuitforge.io' },
        update: {},
        create: {
            email: 'demo@circuitforge.io',
            passwordHash,
            name: 'Demo User',
        },
    });
    console.log(`✓ Created user: ${user.email}`);

    // Create demo organization
    const org = await prisma.organization.upsert({
        where: { id: 'demo-org-id' },
        update: {},
        create: {
            id: 'demo-org-id',
            name: 'Demo Organization',
        },
    });
    console.log(`✓ Created organization: ${org.name}`);

    // Add user as owner
    await prisma.orgMembership.upsert({
        where: {
            orgId_userId: {
                orgId: org.id,
                userId: user.id,
            },
        },
        update: {},
        create: {
            orgId: org.id,
            userId: user.id,
            role: OrgRole.OWNER,
        },
    });
    console.log(`✓ Added user as org owner`);

    // Create public templates (inline simple set + the JSON-file flagship set)
    for (const template of [...templates, ...loadFileTemplates()]) {
        await prisma.template.upsert({
            where: {
                id: `template-${template.name.toLowerCase().replace(/\s+/g, '-')}`,
            },
            update: {
                name: template.name,
                description: template.description,
                tags: template.tags,
                circuitJson: template.circuitJson,
            },
            create: {
                id: `template-${template.name.toLowerCase().replace(/\s+/g, '-')}`,
                orgId: null, // Public template
                name: template.name,
                description: template.description,
                tags: template.tags,
                circuitJson: template.circuitJson,
            },
        });
        console.log(`✓ Created template: ${template.name}`);
    }

    // Create a sample project
    const project = await prisma.project.upsert({
        where: {
            orgId_name: {
                orgId: org.id,
                name: 'My First Circuit',
            },
        },
        update: {},
        create: {
            orgId: org.id,
            name: 'My First Circuit',
            description: 'A sample project to get started',
        },
    });
    console.log(`✓ Created project: ${project.name}`);

    // Create initial version
    await prisma.projectVersion.upsert({
        where: {
            projectId_versionNumber: {
                projectId: project.id,
                versionNumber: 1,
            },
        },
        update: {},
        create: {
            projectId: project.id,
            versionNumber: 1,
            createdByUserId: user.id,
            circuitJson: templates[0]!.circuitJson,
            uiJson: {
                viewport: { x: 0, y: 0, zoom: 1 },
                positions: {},
            },
        },
    });
    console.log(`✓ Created project version: v1`);

    console.log('\n✅ Seed completed successfully!');
    console.log('\nDemo credentials:');
    console.log('  Email: demo@circuitforge.io');
    console.log('  Password: demo123456');
}

main()
    .catch((e) => {
        console.error('❌ Seed failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });