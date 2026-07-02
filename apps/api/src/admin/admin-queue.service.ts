/**
 * AdminQueueService — read-only BullMQ visibility for the operator dashboard.
 *
 * Injects its OWN handles to the 'simulations' and 'design' queues (registered in AdminModule with an
 * inline connection, mirroring GenerationModule) — a separate client to the SAME named Redis queues, so
 * job counts and (Phase 3) pause/resume act on the real queues without depending on the feature modules.
 */
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export interface QueueHealth {
    name: string;
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: boolean;
}

@Injectable()
export class AdminQueueService {
    constructor(
        @InjectQueue('simulations') private readonly simQueue: Queue,
        @InjectQueue('design') private readonly designQueue: Queue,
    ) {}

    /** Depth + paused-state for both queues (waiting/active/failed/... straight from Redis). */
    async health(): Promise<{ simulations: QueueHealth; design: QueueHealth }> {
        const [simulations, design] = await Promise.all([
            this.countsFor(this.simQueue),
            this.countsFor(this.designQueue),
        ]);
        return { simulations, design };
    }

    private async countsFor(queue: Queue): Promise<QueueHealth> {
        const [counts, paused] = await Promise.all([
            queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
            queue.isPaused(),
        ]);
        return {
            name: queue.name,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            completed: counts.completed ?? 0,
            failed: counts.failed ?? 0,
            delayed: counts.delayed ?? 0,
            paused,
        };
    }

    /**
     * Remove a job from the simulation queue by id (the API enqueues sims with jobId = the DB row id).
     * Returns true if a waiting job was removed. An ACTIVE (locked) job can't be removed -> BullMQ throws
     * -> false, which is exactly what "can't cancel a running sim" should report. A non-existent id -> 0.
     */
    async removeSimJob(jobId: string): Promise<boolean> {
        try {
            const removed = await this.simQueue.remove(jobId);
            return typeof removed === 'number' ? removed > 0 : true;
        } catch {
            return false;
        }
    }

    /** Re-enqueue a simulation with a stored payload (jobId = row id, so it dedups to that one job). */
    async enqueueSim(payload: {
        jobId: string;
        orgId: string;
        netlist: string;
        probeNames: string[];
        analysisType: string;
        analysisConfig: unknown;
    }): Promise<void> {
        await this.simQueue.add('simulation', { ...payload, otel: {} }, { jobId: payload.jobId });
    }
}
