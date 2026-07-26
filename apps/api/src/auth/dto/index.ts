/**
 * Auth DTOs
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsOptional, IsString, MinLength, MaxLength } from 'class-validator';

export class RegisterDto {
    @ApiProperty({ example: 'user@example.com' })
    @IsEmail()
    email!: string;

    @ApiProperty({ example: 'securePassword123' })
    @IsString()
    @MinLength(8)
    @MaxLength(100)
    password!: string;

    @ApiProperty({ example: 'John Doe' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name!: string;
}

export class LoginDto {
    @ApiProperty({ example: 'user@example.com' })
    @IsEmail()
    email!: string;

    @ApiProperty({ example: 'securePassword123' })
    @IsString()
    password!: string;
}

export class RefreshDto {
    @ApiProperty()
    @IsString()
    refreshToken!: string;
}

export class LogoutDto {
    @ApiProperty({ required: false, description: 'The refresh token to revoke (its whole session family dies)' })
    @IsOptional()
    @IsString()
    refreshToken?: string;

    @ApiProperty({ required: false, description: 'Revoke ALL of this user’s sessions (log out everywhere)' })
    @IsOptional()
    @IsBoolean()
    allDevices?: boolean;
}

export class VerifyEmailDto {
    @ApiProperty({ description: 'The token from the verification link' })
    @IsString()
    @MinLength(1)
    @MaxLength(256)
    token!: string;
}

export class ResendVerificationDto {
    @ApiProperty({ example: 'user@example.com' })
    @IsEmail()
    email!: string;
}

export class ForgotPasswordDto {
    @ApiProperty({ example: 'user@example.com' })
    @IsEmail()
    email!: string;
}

export class ResetPasswordDto {
    @ApiProperty({ description: 'The token from the password-reset link' })
    @IsString()
    @MinLength(1)
    @MaxLength(256)
    token!: string;

    @ApiProperty({ example: 'newSecurePassword123' })
    @IsString()
    @MinLength(8)
    @MaxLength(100)
    newPassword!: string;
}
