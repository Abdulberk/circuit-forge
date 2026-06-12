/**
 * Transactional email.
 *
 * Ships with a LOG transport (default): the message — including the verification / reset link — is
 * written to the application log, so the account-lifecycle flows work end-to-end in dev/staging with
 * zero configuration. Production wires a real transport (SMTP / provider) at the marked seam in
 * `send()`. "Inert until configured", mirroring the rest of the system: no email infra to stand up
 * before the security mechanism (tokens, expiry, single-use) is usable.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmailService {
    private readonly logger = new Logger(EmailService.name);
    private readonly appUrl: string;

    constructor(private readonly config: ConfigService) {
        // Where the browser app lives — the links in emails point here. Trailing slash trimmed.
        this.appUrl = (this.config.get<string>('APP_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
    }

    /** Absolute link the user clicks to confirm their email. */
    verificationLink(token: string): string {
        return `${this.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
    }

    /** Absolute link the user clicks to choose a new password. */
    passwordResetLink(token: string): string {
        return `${this.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    }

    async sendVerificationEmail(to: string, token: string): Promise<void> {
        await this.send(
            to,
            'Verify your Circuit Forge email',
            `Welcome to Circuit Forge. Confirm your email address:\n${this.verificationLink(token)}\n(This link expires in 24 hours.)`,
        );
    }

    async sendPasswordResetEmail(to: string, token: string): Promise<void> {
        await this.send(
            to,
            'Reset your Circuit Forge password',
            `We received a request to reset your password. If it was you, choose a new one:\n${this.passwordResetLink(token)}\n(This link expires in 1 hour. If it wasn't you, ignore this email.)`,
        );
    }

    /**
     * Deliver a message. Default: log transport. PRODUCTION SEAM — to send real email, add an SMTP
     * or provider transport here (e.g. nodemailer gated on SMTP_HOST) and fall back to logging when
     * it isn't configured. Kept log-only for now so this ships dependency-free.
     */
    private async send(to: string, subject: string, body: string): Promise<void> {
        this.logger.log(`[email:log-transport] to=<${to}> subject="${subject}"\n${body}`);
    }
}
