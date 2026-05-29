import { PrismaClient, OrgRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { readFileSync } from 'fs';
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
                    designator: 'GND',
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
                    designator: 'GND',
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
                    designator: 'GND',
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
                    designator: 'GND',
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
                    designator: 'GND',
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
];

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

    // Create public templates
    for (const template of templates) {
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