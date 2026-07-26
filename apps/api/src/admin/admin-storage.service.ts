/**
 * AdminStorageService — the S3 orphan-object sweep (an explicit operator lever, like the queue
 * pause/purge kill-switches; no background magic).
 *
 * WHY: two ways a model object outlives its DB row — (1) presigned uploads that were PUT but never
 * committed (no Asset row was ever created), and (2) objects historically leaked by deleteAsset before
 * it deleted the object. Both live under `orgs/{orgId}/models/…` and are invisible to the storage
 * quota (it aggregates Asset rows), so they silently consume the bucket forever.
 *
 * SCOPE — `orgs/` prefix ONLY, by design: `results/{jobId}` and `layouts/{jobId}` objects are owned by
 * append-only SimulationJob/LayoutJob rows that are never deleted today (there is no org-delete
 * endpoint), so every one of them is still referenced — sweeping or age-expiring those prefixes would
 * DELETE LIVE DATA behind valid rows. If an org-erase (GDPR Faz 4) ever lands, its delete path must
 * remove those objects with the rows.
 *
 * SAFETY: an object is deleted only if (a) NO Asset row references its key AND (b) it is older than
 * the grace window — so an upload whose commit is still in flight is never swept (default 7 days;
 * the DTO allows 0 for tests). The decision is a PURE function (exported for unit tests, mirroring
 * the reaper pattern); dryRun returns the same tally without deleting.
 */
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

export interface SweepableObject {
    key: string;
    lastModified: Date | null;
    sizeBytes: number;
}

export interface SweepResult {
    dryRun: boolean;
    olderThanDays: number;
    /** objects listed under the orgs/ prefix */
    scanned: number;
    /** objects with a live Asset row (kept) */
    referenced: number;
    /** unreferenced objects still inside the grace window (kept this sweep) */
    skippedFresh: number;
    /** unreferenced + past-grace objects (deleted unless dryRun) */
    orphans: number;
    deleted: number;
    freedBytes: number;
    /** first few orphan keys, for the audit row / operator eyeball */
    sampleKeys: string[];
}

/**
 * PURE decision: which listed objects are sweepable orphans? Unreferenced AND older than the cutoff.
 * An object with no LastModified (shouldn't happen on S3/MinIO) is treated as FRESH — never swept on
 * missing evidence.
 */
export function decideOrphans(
    objects: SweepableObject[],
    referencedKeys: ReadonlySet<string>,
    cutoffMs: number,
): { orphans: SweepableObject[]; referenced: number; skippedFresh: number } {
    const orphans: SweepableObject[] = [];
    let referenced = 0;
    let skippedFresh = 0;
    for (const o of objects) {
        if (referencedKeys.has(o.key)) {
            referenced++;
        } else if (o.lastModified && o.lastModified.getTime() < cutoffMs) {
            orphans.push(o);
        } else {
            skippedFresh++;
        }
    }
    return { orphans, referenced, skippedFresh };
}

const MODELS_PREFIX = 'orgs/';
/** S3 DeleteObjects hard limit per request. */
const DELETE_BATCH = 1000;
/** Prisma `IN` chunk for the reference check (bounded query size). */
const DB_CHUNK = 500;

@Injectable()
export class AdminStorageService {
    private readonly logger = new Logger(AdminStorageService.name);
    private readonly s3: S3Client;
    private readonly bucket: string;

    constructor(private readonly prisma: PrismaService) {
        // Same self-contained client shape as AssetsService/LayoutService (env-configured).
        this.bucket = process.env.S3_BUCKET || 'circuitforge';
        this.s3 = new S3Client({
            endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
            region: process.env.S3_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
                secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin',
            },
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        });
    }

    /** One sweep over the model-asset prefix. List → reference-check against Asset rows → delete orphans. */
    async sweepOrphanModelAssets(opts: { olderThanDays: number; dryRun: boolean }): Promise<SweepResult> {
        const cutoffMs = Date.now() - opts.olderThanDays * 24 * 60 * 60 * 1000;

        const objects = await this.listModelObjects();
        const referencedKeys = await this.referencedKeys(objects.map((o) => o.key));
        const { orphans, referenced, skippedFresh } = decideOrphans(objects, referencedKeys, cutoffMs);
        const { deleted, freedBytes } = opts.dryRun ? { deleted: 0, freedBytes: 0 } : await this.deleteOrphans(orphans);

        const result: SweepResult = {
            dryRun: opts.dryRun,
            olderThanDays: opts.olderThanDays,
            scanned: objects.length,
            referenced,
            skippedFresh,
            orphans: orphans.length,
            deleted,
            // dryRun reports the WOULD-free total so the operator preview / audit row is meaningful.
            freedBytes: opts.dryRun ? orphans.reduce((s, o) => s + o.sizeBytes, 0) : freedBytes,
            sampleKeys: orphans.slice(0, 10).map((o) => o.key),
        };
        this.logger.log(
            `orphan-model sweep: scanned=${result.scanned} referenced=${result.referenced} fresh=${result.skippedFresh} orphans=${result.orphans} deleted=${result.deleted}${opts.dryRun ? ' (dry-run)' : ''}`,
        );
        return result;
    }

    /** Every object under the orgs/ prefix (paginated ListObjectsV2). */
    private async listModelObjects(): Promise<SweepableObject[]> {
        const objects: SweepableObject[] = [];
        let continuationToken: string | undefined;
        do {
            const page = await this.s3.send(
                new ListObjectsV2Command({ Bucket: this.bucket, Prefix: MODELS_PREFIX, ContinuationToken: continuationToken }),
            );
            for (const c of page.Contents ?? []) {
                if (c.Key) objects.push({ key: c.Key, lastModified: c.LastModified ?? null, sizeBytes: c.Size ?? 0 });
            }
            continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (continuationToken);
        return objects;
    }

    /** Which of these keys have a live Asset row? (chunked IN queries — never one giant array) */
    private async referencedKeys(keys: string[]): Promise<Set<string>> {
        const referenced = new Set<string>();
        for (let i = 0; i < keys.length; i += DB_CHUNK) {
            const rows = await this.prisma.asset.findMany({
                where: { s3Key: { in: keys.slice(i, i + DB_CHUNK) } },
                select: { s3Key: true },
            });
            for (const r of rows) referenced.add(r.s3Key);
        }
        return referenced;
    }

    /** Batched DeleteObjects with a per-batch reference RE-CHECK (TOCTOU hardening): a LATE commit
     *  (commitAsset accepts an arbitrary-age client key, so the grace window can't cover it) may have
     *  referenced a key after the initial check — re-verifying right before each delete shrinks the race
     *  window from the whole list+check duration to milliseconds, and makes olderThanDays=0 safe. */
    private async deleteOrphans(orphans: SweepableObject[]): Promise<{ deleted: number; freedBytes: number }> {
        let deleted = 0;
        let freedBytes = 0;
        for (let i = 0; i < orphans.length; i += DELETE_BATCH) {
            const candidates = orphans.slice(i, i + DELETE_BATCH);
            const nowReferenced = await this.referencedKeys(candidates.map((o) => o.key));
            if (nowReferenced.size > 0) this.logger.warn(`sweep skipped ${nowReferenced.size} key(s) committed mid-sweep`);
            const batch = candidates.filter((o) => !nowReferenced.has(o.key));
            if (batch.length === 0) continue;

            const res = await this.s3.send(
                new DeleteObjectsCommand({
                    Bucket: this.bucket,
                    Delete: { Objects: batch.map((o) => ({ Key: o.key })), Quiet: true },
                }),
            );
            // Quiet mode only reports failures; successes = batch minus errors. freedBytes is computed per
            // batch from the ACTUAL failures (never a positional slice over the whole orphan list).
            const failedKeys = new Set((res.Errors ?? []).map((e) => e.Key));
            deleted += batch.length - failedKeys.size;
            freedBytes += batch.reduce((s, o) => s + (failedKeys.has(o.key) ? 0 : o.sizeBytes), 0);
            for (const err of res.Errors ?? []) {
                this.logger.warn(`sweep could not delete ${err.Key}: ${err.Code} ${err.Message}`);
            }
        }
        return { deleted, freedBytes };
    }
}
