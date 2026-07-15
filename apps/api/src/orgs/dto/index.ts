/**
 * Organizations DTOs
 */
import { IsString, IsOptional, IsUUID, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class CreateOrgDto {
    @ApiProperty({ example: 'My Company' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name!: string;
}

/**
 * Query for the org-scoped audit-log read (GET /orgs/:orgId/audit-logs). Note the absence of an `orgId`
 * filter (it is fixed by the path — a tenant can only ever read its OWN org) and of `adminActorId` (the
 * operator's identity is never exposed to tenants — see the redaction in OrgsService.listAuditLogs).
 */
export class OrgAuditQueryDto extends PaginationQueryDto {
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

    @ApiPropertyOptional({ description: 'Filter by the subject member (user id)' })
    @IsOptional()
    @IsUUID()
    userId?: string;
}