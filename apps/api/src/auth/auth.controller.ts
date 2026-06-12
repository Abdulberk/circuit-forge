/**
 * Auth Controller
 */
import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService, TokensResponse } from './auth.service';
import { RegisterDto, LoginDto, RefreshDto } from './dto';

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
    async register(@Body() dto: RegisterDto): Promise<TokensResponse> {
        return this.authService.register(dto.email, dto.password, dto.name);
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
    async login(@Body() dto: LoginDto): Promise<TokensResponse> {
        return this.authService.login(dto.email, dto.password);
    }

    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Refresh access token' })
    @ApiResponse({ status: 200, description: 'Token refreshed' })
    @ApiResponse({ status: 401, description: 'Invalid refresh token' })
    async refresh(@Body() dto: RefreshDto): Promise<TokensResponse> {
        return this.authService.refresh(dto.refreshToken);
    }

    @Post('logout')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Logout (client-side token invalidation)' })
    @ApiResponse({ status: 204, description: 'Logged out' })
    async logout(): Promise<void> {
        // Client should delete tokens
        return;
    }
}