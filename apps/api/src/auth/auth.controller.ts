/**
 * Auth Controller
 */
import { Controller, Post, Body, HttpCode, HttpStatus, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { AuthService, TokensResponse, AuthContext } from './auth.service';
import {
    RegisterDto,
    LoginDto,
    RefreshDto,
    LogoutDto,
    VerifyEmailDto,
    ResendVerificationDto,
    ForgotPasswordDto,
    ResetPasswordDto,
} from './dto';

/** Client metadata for audit rows / session records (trust-proxy is set, so req.ip is the client). */
const ctxOf = (req: Request): AuthContext => ({
    ip: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 256) : undefined,
});

@ApiTags('auth')
@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) { }

    @Post('register')
    // Tight per-IP cap on account creation (anti-spam). Pairs with email verification (Batch 2).
    @Throttle({ default: { limit: 20, ttl: 3600000 } })
    @ApiOperation({ summary: 'Register a new user' })
    @ApiResponse({ status: 201, description: 'User registered successfully' })
    @ApiResponse({ status: 409, description: 'Email already registered' })
    async register(@Body() dto: RegisterDto, @Req() req: Request): Promise<TokensResponse> {
        return this.authService.register(dto.email, dto.password, dto.name, ctxOf(req));
    }

    @Post('login')
    // Per-IP brute-force throttle (the per-account lockout in AuthService is the second layer that
    // survives a distributed/rotating-IP attack).
    @Throttle({ default: { limit: 10, ttl: 60000 } })
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Login with email and password' })
    @ApiResponse({ status: 200, description: 'Login successful' })
    @ApiResponse({ status: 401, description: 'Invalid credentials' })
    @ApiResponse({ status: 429, description: 'Rate-limited, or account temporarily locked (code ACCOUNT_LOCKED)' })
    async login(@Body() dto: LoginDto, @Req() req: Request): Promise<TokensResponse> {
        return this.authService.login(dto.email, dto.password, ctxOf(req));
    }

    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Refresh access token (ROTATING: the old refresh token is single-use)' })
    @ApiResponse({ status: 200, description: 'New token pair — REPLACE the stored refresh token with the returned one' })
    @ApiResponse({ status: 401, description: 'Invalid/expired/already-used refresh token (reuse revokes the whole session)' })
    async refresh(@Body() dto: RefreshDto, @Req() req: Request): Promise<TokensResponse> {
        return this.authService.refresh(dto.refreshToken, ctxOf(req));
    }

    @Post('verify-email')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ default: { limit: 20, ttl: 3600000 } })
    @ApiOperation({ summary: 'Confirm an email-verification token' })
    @ApiResponse({ status: 204, description: 'Email verified' })
    @ApiResponse({ status: 400, description: 'Invalid or expired token' })
    async verifyEmail(@Body() dto: VerifyEmailDto): Promise<void> {
        await this.authService.verifyEmail(dto.token);
    }

    @Post('resend-verification')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ default: { limit: 5, ttl: 3600000 } })
    @ApiOperation({ summary: 'Re-send the verification email (always 204 — never reveals account state)' })
    @ApiResponse({ status: 204, description: 'If the account exists and is unverified, an email was sent' })
    async resendVerification(@Body() dto: ResendVerificationDto): Promise<void> {
        await this.authService.resendVerification(dto.email);
    }

    @Post('forgot-password')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ default: { limit: 5, ttl: 3600000 } })
    @ApiOperation({ summary: 'Request a password-reset link (always 204 — never reveals account state)' })
    @ApiResponse({ status: 204, description: 'If the account exists, a reset email was sent' })
    async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
        await this.authService.forgotPassword(dto.email);
    }

    @Post('reset-password')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ default: { limit: 10, ttl: 3600000 } })
    @ApiOperation({ summary: 'Set a new password using a reset token' })
    @ApiResponse({ status: 204, description: 'Password updated' })
    @ApiResponse({ status: 400, description: 'Invalid or expired token' })
    async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
        await this.authService.resetPassword(dto.token, dto.newPassword);
    }

    @Post('logout')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Logout — revokes the refresh-token session server-side (always 204)' })
    @ApiResponse({ status: 204, description: 'Session revoked (best-effort); client must also delete its tokens' })
    async logout(@Body() dto: LogoutDto, @Req() req: Request): Promise<void> {
        await this.authService.logout(dto?.refreshToken, dto?.allDevices === true, ctxOf(req));
    }
}