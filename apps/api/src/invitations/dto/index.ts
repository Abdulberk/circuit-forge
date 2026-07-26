/**
 * Invitation DTOs.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** Invite someone (by email) to join an org. */
export class CreateInvitationDto {
    @ApiProperty({ example: 'teammate@example.com' })
    @IsEmail()
    email!: string;

    @ApiPropertyOptional({ enum: OrgRole, default: OrgRole.MEMBER, description: 'Role to grant on accept (default MEMBER)' })
    @IsOptional()
    @IsEnum(OrgRole)
    role?: OrgRole;
}

/** Accept an invitation using the token from the emailed link (as the logged-in invitee). */
export class AcceptInvitationDto {
    @ApiProperty({ description: 'The token from the invitation email link' })
    @IsString()
    @MaxLength(200)
    token!: string;
}
