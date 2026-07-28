/**
 * The operator kill switch — which queues an admin can actually stop.
 *
 * 'pcb-layout' was missing from this registry, which made it the only expensive job type with no live
 * lever: no pause, no resume, no purge. It is also the queue that needs one most — a PCB layout is minutes
 * of freerouting and KiCad DRC and the worker drains one at a time, so a runaway tenant blocks every other
 * org's boards with no in-product remedy at all.
 *
 * These pin the registry itself rather than BullMQ's behaviour: the defect was a name absent from a list,
 * and a list is exactly the kind of thing that silently loses an entry.
 */
import { BadRequestException } from '@nestjs/common';

import { AdminQueueService, ADMIN_QUEUE_NAMES, PURGEABLE_STATUSES } from './admin-queue.service';

const fakeQueue = (name: string): Record<string, jest.Mock> => ({
    __name: jest.fn(() => name),
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 1, active: 0, completed: 3, failed: 0, delayed: 0 }),
    isPaused: jest.fn().mockResolvedValue(false),
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
    clean: jest.fn().mockResolvedValue([]),
    add: jest.fn().mockResolvedValue(undefined),
});

const queues = {
    simulations: fakeQueue('simulations'),
    design: fakeQueue('design'),
    'pcb-layout': fakeQueue('pcb-layout'),
};

const service = (): AdminQueueService =>
    new AdminQueueService(queues.simulations as never, queues.design as never, queues['pcb-layout'] as never);

beforeEach(() => jest.clearAllMocks());

describe('ADMIN_QUEUE_NAMES — every expensive job type must be controllable', () => {
    it('covers all three queues, PCB layout included', () => {
        expect([...ADMIN_QUEUE_NAMES].sort()).toEqual(['design', 'pcb-layout', 'simulations']);
    });

    it('health reports every queue in the registry — no queue is invisible to the operator', async () => {
        const health = await service().health();
        expect(Object.keys(health).sort()).toEqual([...ADMIN_QUEUE_NAMES].sort());
        for (const name of ADMIN_QUEUE_NAMES) expect(health[name]).toMatchObject({ waiting: 1, paused: false });
    });
});

describe('the kill switch reaches the PCB layout queue', () => {
    it('pauses and resumes it', async () => {
        const svc = service();
        await svc.pause('pcb-layout');
        expect(queues['pcb-layout'].pause).toHaveBeenCalledTimes(1);
        await svc.resume('pcb-layout');
        expect(queues['pcb-layout'].resume).toHaveBeenCalledTimes(1);
        // and it does not reach across to a different queue
        expect(queues.simulations.pause).not.toHaveBeenCalled();
        expect(queues.design.pause).not.toHaveBeenCalled();
    });

    it('purges terminal history from it', async () => {
        await service().purge('pcb-layout', PURGEABLE_STATUSES[0]);
        expect(queues['pcb-layout'].clean).toHaveBeenCalled();
    });

    it('still rejects a queue that is not in the registry', async () => {
        await expect(service().pause('parts' as never)).rejects.toBeInstanceOf(BadRequestException);
    });
});
