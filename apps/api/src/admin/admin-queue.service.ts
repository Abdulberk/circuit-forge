/**
 * AdminQueueService — read-only BullMQ visibility for the operator dashboard.
 *
 * Injects its OWN handles to the 'simulations' and 'design' queues (registered in AdminModule with an
 * inline connection, mirroring GenerationModule) — a separate client to the SAME named Redis queues, so
 * job counts and (Phase 3) pause/resume act on the real queues without depending on the feature modules.
 */
import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable } from '@nestjs/common';
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

/** The two admin-controllable queues. */
export const ADMIN_QUEUE_NAMES = ['simulations', 'design'] as const;
export type AdminQueueName = (typeof ADMIN_QUEUE_NAMES)[number];

/** Job states an admin may purge — terminal/history cruft only. NEVER 'active' (a running job) or
 *  'wait'/'delayed' (pending work a purge would silently cancel). */
export const PURGEABLE_STATUSES = ['completed', 'failed'] as const;
export type PurgeableStatus = (typeof PURGEABLE_STATUSES)[number];

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

    // ---------------------------------------------------------------- kill-switch + maintenance

    private byName(name: string): Queue {
        if (name === 'simulations') return this.simQueue;
        if (name === 'design') return this.designQueue;
        throw new BadRequestException(`Unknown queue "${name}" (allowed: ${ADMIN_QUEUE_NAMES.join(', ')}).`);
    }

    /** Pause consumption on a queue (BullMQ-global via Redis): in-flight jobs drain, no new ones start. */
    async pause(name: string): Promise<{ name: string; paused: boolean }> {
        const queue = this.byName(name);
        await queue.pause();
        return { name, paused: true };
    }

    /** Resume a paused queue. */
    async resume(name: string): Promise<{ name: string; paused: boolean }> {
        const queue = this.byName(name);
        await queue.resume();
        return { name, paused: false };
    }

    /**
     * Purge terminal job-record cruft (completed/failed history) from a queue. grace=0 → all of that
     * status. Bounded by `limit`. Never touches active/waiting/delayed jobs, so it can't cancel pending
     * work — it only reclaims Redis memory from finished records.
     */
    async purge(name: string, status: PurgeableStatus, limit = 10000): Promise<{ name: string; status: string; removed: number }> {
        const queue = this.byName(name);
        const removed = await queue.clean(0, limit, status);
        return { name, status, removed: removed.length };
    }
}
