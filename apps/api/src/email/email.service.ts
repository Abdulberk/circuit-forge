/**
 * Transactional email.
 *
 * Provider-agnostic: the active transport (SES / SMTP / log) is chosen at boot from config (see
 * email-transports.ts), SES-first. With nothing configured it uses the LOG transport, so the
 * account-lifecycle flows work end-to-end in dev/CI with zero setup. Sending is best-effort — a
 * delivery failure is logged, never thrown, so it can't break registration or password-reset
 * (the token is already persisted; the user can resend / retry).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { resolveEmailTransport, type EmailTransport } from './email-transports';
import { verificationEmail, passwordResetEmail, orgInviteEmail, type EmailContent } from './templates';

@Injectable()
export class EmailService {
    private readonly logger = new Logger(EmailService.name);
    private readonly appUrl: string;
    private readonly transport: EmailTransport;

    constructor(private readonly config: ConfigService) {
        // Where the browser app lives — the links in emails point here. Trailing slash trimmed.
        this.appUrl = (this.config.get<string>('APP_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
        this.transport = resolveEmailTransport(this.config);
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
        await this.send(to, verificationEmail(this.verificationLink(token)));
    }

    async sendPasswordResetEmail(to: string, token: string): Promise<void> {
        await this.send(to, passwordResetEmail(this.passwordResetLink(token)));
    }

    /** Absolute link the invitee clicks to accept an org invitation. */
    inviteLink(token: string): string {
        return `${this.appUrl}/accept-invite?token=${encodeURIComponent(token)}`;
    }

    async sendOrgInviteEmail(to: string, token: string, orgName: string, inviterName: string): Promise<void> {
        await this.send(to, orgInviteEmail(this.inviteLink(token), orgName, inviterName));
    }

    /**
     * Deliver a message via the configured transport. Best-effort: a transport failure is logged and
     * swallowed so the calling auth flow (register / forgot-password) still completes — the security
     * token is already stored, and the user can resend or retry verification.
     */
    private async send(to: string, content: EmailContent): Promise<void> {
        try {
            await this.transport.send({ to, subject: content.subject, text: content.text, html: content.html });
        } catch (e) {
            this.logger.error(`email send failed (transport=${this.transport.name}, to=<${to}>): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
