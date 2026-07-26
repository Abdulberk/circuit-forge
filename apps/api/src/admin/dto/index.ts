/**
 * Admin API DTOs. Query DTOs extend the shared PaginationQueryDto so every admin list is bounded and
 * returns the standard { items, total, limit, offset, hasMore } envelope. (Phase 2 adds mutation DTOs.)
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SimJobStatus, DesignJobStatus, PlatformRole, OrgRole } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { PURGEABLE_STATUSES, type PurgeableStatus } from '../admin-queue.service';

export class AdminUsersQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional({ description: 'Case-insensitive substring match on email or name' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    search?: string;
}

export class AdminOrgsQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional({ description: 'Case-insensitive substring match on org name' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    search?: string;
}

export class AdminSimJobsQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional({ description: 'Filter by organization id' })
    @IsOptional()
    @IsUUID()
    orgId?: string;

    @ApiPropertyOptional({ enum: SimJobStatus, description: 'Filter by job status' })
    @IsOptional()
    @IsEnum(SimJobStatus)
    status?: SimJobStatus;
}

export class AdminDesignJobsQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional({ description: 'Filter by organization id' })
    @IsOptional()
    @IsUUID()
    orgId?: string;

    @ApiPropertyOptional({ enum: DesignJobStatus, description: 'Filter by job status' })
    @IsOptional()
    @IsEnum(DesignJobStatus)
    status?: DesignJobStatus;
}

export class AdminAuditQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional({ description: 'Filter by organization id' })
    @IsOptional()
    @IsUUID()
    orgId?: string;

    @ApiPropertyOptional({ description: 'Filter by subject user id' })
    @IsOptional()
    @IsUUID()
    userId?: string;

    @ApiPropertyOptional({ description: 'Filter by the acting platform admin id' })
    @IsOptional()
    @IsUUID()
    adminActorId?: string;

    @ApiPropertyOptional({ description: 'Exact action match, e.g. "admin.org.suspend"' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    action?: string;

    @ApiPropertyOptional({ description: 'Exact entityType match, e.g. "Organization"' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    entityType?: string;
}

// ---------------------------------------------------------------- mutation DTOs (Phase 2)

/** Reason attached to a mutation's audit row (why the admin took the action). */
class ReasonDto {
    @ApiPropertyOptional({ description: 'Free-text reason recorded in the audit trail' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    reason?: string;
}

export class LockUserDto extends ReasonDto {
    @ApiProperty({ description: 'true = lock the account, false = unlock' })
    @IsBoolean()
    locked!: boolean;

    @ApiPropertyOptional({ description: 'ISO datetime the lock expires; omit when locking for a far-future (indefinite) lock' })
    @IsOptional()
    @IsDateString()
    until?: string;
}

export class SetPlatformRoleDto extends ReasonDto {
    @ApiProperty({ enum: PlatformRole, description: 'New platform role' })
    @IsEnum(PlatformRole)
    platformRole!: PlatformRole;
}

export class SetEmailVerifiedDto extends ReasonDto {
    @ApiProperty({ description: 'Override the email-verified flag' })
    @IsBoolean()
    verified!: boolean;
}

export class RenameOrgDto extends ReasonDto {
    @ApiProperty({ description: 'New organization name' })
    @IsString()
    @MaxLength(200)
    name!: string;
}

export class SuspendOrgDto extends ReasonDto {
    @ApiProperty({ description: 'true = suspend (block writes), false = reinstate' })
    @IsBoolean()
    suspended!: boolean;
}

export class AddMemberDto extends ReasonDto {
    @ApiProperty({ description: 'User to add to the org' })
    @IsUUID()
    userId!: string;

    @ApiProperty({ enum: OrgRole, description: 'Tenant role in the org' })
    @IsEnum(OrgRole)
    role!: OrgRole;
}

export class UpdateMemberRoleDto extends ReasonDto {
    @ApiProperty({ enum: OrgRole, description: 'New tenant role' })
    @IsEnum(OrgRole)
    role!: OrgRole;
}

/**
 * Per-org quota override. Each metric: a POSITIVE integer sets the override; `null` clears it (inherit the
 * env default); OMITTING it leaves the current value unchanged. (storageBytes is bytes; may exceed Int32.)
 */
export class SetQuotaOverrideDto extends ReasonDto {
    @ApiPropertyOptional({ nullable: true, description: 'In-flight sim cap (null clears)' })
    @IsOptional()
    @IsInt()
    @Min(1)
    simConcurrent?: number | null;

    @ApiPropertyOptional({ nullable: true, description: 'Sim jobs per month (null clears)' })
    @IsOptional()
    @IsInt()
    @Min(1)
    simJobsPerMonth?: number | null;

    @ApiPropertyOptional({ nullable: true, description: 'Sim runtime ms per month (null clears)' })
    @IsOptional()
    @IsInt()
    @Min(1)
    simRuntimeMsPerMonth?: number | null;

    @ApiPropertyOptional({ nullable: true, description: 'In-flight design cap (null clears)' })
    @IsOptional()
    @IsInt()
    @Min(1)
    designConcurrent?: number | null;

    @ApiPropertyOptional({ nullable: true, description: 'Design jobs per month (null clears)' })
    @IsOptional()
    @IsInt()
    @Min(1)
    designJobsPerMonth?: number | null;

    @ApiPropertyOptional({ nullable: true, description: 'Storage bytes cap (null clears)' })
    @IsOptional()
    @IsInt()
    @Min(1)
    storageBytes?: number | null;

    @ApiPropertyOptional({ nullable: true, description: 'Parts calls per month (null clears)' })
    @IsOptional()
    @IsInt()
    @Min(1)
    partsCallsPerMonth?: number | null;
}

/** Bare reason payload for actions with no other body (logout-all, job cancel/retry, queue pause/resume). */
export class ActionReasonDto extends ReasonDto {}

export class PurgeQueueDto extends ReasonDto {
    @ApiProperty({ enum: PURGEABLE_STATUSES, description: 'Which terminal job records to purge (completed/failed history)' })
    @IsIn(PURGEABLE_STATUSES as unknown as string[])
    status!: PurgeableStatus;
}

/**
 * S3 orphan-model sweep. Deletes objects under `orgs/…/models/…` that have NO Asset row and are older
 * than the grace window (protects uploads whose commit is still in flight). dryRun reports the tally
 * without deleting anything.
 */
export class SweepOrphanModelsDto extends ReasonDto {
    @ApiPropertyOptional({ default: 7, description: 'Grace window: only unreferenced objects OLDER than this many days are swept' })
    @IsOptional()
    @IsInt()
    @Min(0)
    olderThanDays?: number;

    @ApiPropertyOptional({ default: false, description: 'Report what would be swept without deleting' })
    @IsOptional()
    @IsBoolean()
    dryRun?: boolean;
}
