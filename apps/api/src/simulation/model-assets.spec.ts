/**
 * SimulationService model-asset binding: a quick sim can attach user-uploaded SPICE model assets,
 * which must be (a) resolved to S3 keys for the worker, (b) org-scoped, (c) sandbox-safe filenames,
 * and (d) collision-free. Constructed with mocked deps (no DB/queue/S3 needed).
 */
import { BadRequestException } from '@nestjs/common';
import { SimulationService } from './simulation.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { VersionsService } from '../versions/versions.service';
import type { OrgsService } from '../orgs/orgs.service';
import type { Queue } from 'bullmq';

interface MockAsset {
    id: string;
    orgId: string;
    type: string;
    s3Key: string;
}

function makeService(assets: MockAsset[] = [], orgs: Array<{ id: string }> = [{ id: 'org-1' }]) {
    const queueAdd = jest.fn(async () => ({}));
    const assetFindMany = jest.fn(async () => assets);
    const jobCreate = jest.fn(async () => ({ id: 'job-1' }));
    const prisma = {
        asset: { findMany: assetFindMany },
        simulationJob: { create: jobCreate },
    } as unknown as PrismaService;
    const orgsService = { findAllForUser: jest.fn(async () => orgs) } as unknown as OrgsService;
    const versionsService = {} as unknown as VersionsService;
    const queue = { add: queueAdd } as unknown as Queue;
    const svc = new SimulationService(prisma, versionsService, orgsService, queue);
    return { svc, queueAdd, assetFindMany };
}

const asset = (id: string, name: string, orgId = 'org-1'): MockAsset => ({
    id,
    orgId,
    type: 'SPICE_MODEL',
    s3Key: `orgs/${orgId}/models/uuid-${id}/${name}`,
});

describe('SimulationService — model-asset binding (createQuickSim)', () => {
    it('resolves asset ids to S3 keys and passes them as modelAssets to the worker queue', async () => {
        const { svc, queueAdd, assetFindMany } = makeService([asset('a1', 'mymodel.lib')]);
        await svc.createQuickSim('* netlist\n.end', { type: 'op' }, 'user-1', ['a1']);
        // scoped to the user's org + SPICE_MODEL only
        expect(assetFindMany).toHaveBeenCalledWith({
            where: { id: { in: ['a1'] }, orgId: 'org-1', type: 'SPICE_MODEL' },
        });
        const payload = (queueAdd.mock.calls[0] as unknown[])[1] as { modelAssets?: string[] };
        expect(payload.modelAssets).toEqual(['orgs/org-1/models/uuid-a1/mymodel.lib']);
    });

    it('omits modelAssets (and never queries assets) when none are requested', async () => {
        const { svc, queueAdd, assetFindMany } = makeService();
        await svc.createQuickSim('* netlist\n.end', { type: 'op' }, 'user-1');
        expect(assetFindMany).not.toHaveBeenCalled();
        expect(((queueAdd.mock.calls[0] as unknown[])[1] as { modelAssets?: string[] }).modelAssets).toBeUndefined();
    });

    it('rejects an id that is not a SPICE model in this org (no cross-org / missing leak)', async () => {
        const { svc } = makeService([]); // requested 1, found 0 (e.g. another org’s asset)
        await expect(svc.createQuickSim('x', { type: 'op' }, 'user-1', ['foreign'])).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('rejects two assets that resolve to the same filename (the worker writes by basename)', async () => {
        const { svc } = makeService([asset('a1', 'model.lib'), asset('a2', 'model.lib')]);
        await expect(svc.createQuickSim('x', { type: 'op' }, 'user-1', ['a1', 'a2'])).rejects.toThrow(/same filename/i);
    });

    it('rejects an unsafe model filename (bad chars / traversal) before it reaches a netlist', async () => {
        const bad = makeService([{ id: 'a1', orgId: 'org-1', type: 'SPICE_MODEL', s3Key: 'orgs/org-1/models/uuid/bad name;rm.lib' }]);
        await expect(bad.svc.createQuickSim('x', { type: 'op' }, 'user-1', ['a1'])).rejects.toThrow(/unsafe filename/i);
        const dots = makeService([{ id: 'a1', orgId: 'org-1', type: 'SPICE_MODEL', s3Key: 'orgs/org-1/models/uuid/..' }]);
        await expect(dots.svc.createQuickSim('x', { type: 'op' }, 'user-1', ['a1'])).rejects.toThrow(/unsafe filename/i);
    });

    it('rejects a model filename that would clobber a worker job file (circuit.cir / output.csv)', async () => {
        const svc1 = makeService([{ id: 'a1', orgId: 'org-1', type: 'SPICE_MODEL', s3Key: 'orgs/org-1/models/uuid/circuit.cir' }]);
        await expect(svc1.svc.createQuickSim('x', { type: 'op' }, 'user-1', ['a1'])).rejects.toThrow(/reserved/i);
        const svc2 = makeService([{ id: 'a1', orgId: 'org-1', type: 'SPICE_MODEL', s3Key: 'orgs/org-1/models/uuid/OUTPUT.CSV' }]);
        await expect(svc2.svc.createQuickSim('x', { type: 'op' }, 'user-1', ['a1'])).rejects.toThrow(/reserved/i);
    });

    it('rejects an unbounded number of model assets (DoS guard)', async () => {
        const ids = Array.from({ length: 40 }, (_, i) => `a${i}`);
        const { svc } = makeService(); // findMany never reached
        await expect(svc.createQuickSim('x', { type: 'op' }, 'user-1', ids)).rejects.toThrow(/too many/i);
    });
});
