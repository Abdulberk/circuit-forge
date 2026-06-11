/**
 * Auth Service
 */
import { Injectable, UnauthorizedException, ConflictException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';

/** Lock an account after this many consecutive failed logins... */
const MAX_FAILED_LOGINS = 5;
/** ...for this long. After it elapses the next attempt starts a fresh count. */
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * A pre-computed argon2 hash to verify against when the email isn't registered, so a failed login
 * costs the same CPU whether or not the account exists — closing a user-enumeration timing oracle.
 * Computed once at module load (verify cost ≈ a real verify).
 */
const DUMMY_VERIFY_HASH = argon2.hash('cf-login-timing-equalizer');

export interface JwtPayload {
    sub: string;
    email: string;
}

export interface TokensResponse {
    accessToken: string;
    refreshToken: string;
    user: {
        id: string;
        email: string;
        name: string;
    };
}

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    constructor(
        private prisma: PrismaService,
        private jwtService: JwtService,
        private configService: ConfigService,
    ) { }

    async register(email: string, password: string, name: string): Promise<TokensResponse> {
        // Check if user exists
        const existing = await this.prisma.user.findUnique({ where: { email } });
        if (existing) {
            throw new ConflictException('Email already registered');
        }

        // Hash password
        const passwordHash = await argon2.hash(password);

        // Create user
        const user = await this.prisma.user.create({
            data: {
                email,
                passwordHash,
                name,
            },
        });

        // Create personal organization
        const org = await this.prisma.organization.create({
            data: {
                name: `${name}'s Workspace`,
                memberships: {
                    create: {
                        userId: user.id,
                        role: 'OWNER',
                    },
                },
            },
        });

        this.logger.log({ userId: user.id, orgId: org.id }, 'User registered');

        return this.generateTokens(user);
    }

    async login(email: string, password: string): Promise<TokensResponse> {
        const user = await this.prisma.user.findUnique({ where: { email } });
        if (!user) {
            // Equalize timing with the real path so a missing account isn't detectable by latency.
            await argon2.verify(await DUMMY_VERIFY_HASH, password).catch(() => false);
            throw new UnauthorizedException('Invalid credentials');
        }

        // Brute-force lockout: while locked, reject without even checking the password.
        if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
            throw this.lockedError(user.lockedUntil);
        }

        const valid = await argon2.verify(user.passwordHash, password);
        if (!valid) {
            await this.recordFailedLogin(user.id, user.failedLoginCount);
            throw new UnauthorizedException('Invalid credentials');
        }

        // Success — clear any accumulated failures / expired lock.
        if (user.failedLoginCount > 0 || user.lockedUntil) {
            await this.prisma.user.update({
                where: { id: user.id },
                data: { failedLoginCount: 0, lockedUntil: null },
            });
        }

        return this.generateTokens(user);
    }

    /** Record a failed attempt; once the threshold is hit, lock the account and reset the counter. */
    private async recordFailedLogin(userId: string, currentCount: number): Promise<void> {
        const count = currentCount + 1;
        const locked = count >= MAX_FAILED_LOGINS;
        await this.prisma.user.update({
            where: { id: userId },
            data: {
                failedLoginCount: locked ? 0 : count,
                lastFailedLoginAt: new Date(),
                ...(locked ? { lockedUntil: new Date(Date.now() + LOCKOUT_MS) } : {}),
            },
        });
        if (locked) this.logger.warn({ userId }, 'Account locked after repeated failed logins');
    }

    /** 429 with a distinct `code` so the frontend can show a "locked" message (not a generic retry). */
    private lockedError(lockedUntil: Date): HttpException {
        const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
        return new HttpException(
            {
                code: 'ACCOUNT_LOCKED',
                retryAfterSeconds,
                message: 'Account temporarily locked due to too many failed login attempts. Try again later.',
            },
            HttpStatus.TOO_MANY_REQUESTS,
        );
    }

    async refresh(refreshToken: string): Promise<TokensResponse> {
        try {
            const payload = this.jwtService.verify(refreshToken, {
                secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
            });

            const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
            if (!user) {
                throw new UnauthorizedException('User not found');
            }

            return this.generateTokens(user);
        } catch (e) {
            throw new UnauthorizedException('Invalid refresh token');
        }
    }

    async validateUser(userId: string) {
        return this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, name: true, createdAt: true },
        });
    }

    private async generateTokens(user: { id: string; email: string; name: string }): Promise<TokensResponse> {
        const payload: JwtPayload = { sub: user.id, email: user.email };

        const [accessToken, refreshToken] = await Promise.all([
            this.jwtService.signAsync(payload),
            this.jwtService.signAsync(payload, {
                secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
                expiresIn: '7d',
            }),
        ]);

        return {
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
            },
        };
    }
}