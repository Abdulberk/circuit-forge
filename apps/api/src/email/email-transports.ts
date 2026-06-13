/**
 * Pluggable email transports. A transport is anything that can deliver an EmailMessage; the active one
 * is chosen at boot from config (SES-first), and adding a provider is just another small class + a
 * branch in resolveEmailTransport(). The LOG transport is the always-available zero-config fallback so
 * the account-lifecycle flows work in dev/CI with nothing to stand up.
 *
 * Selection (EMAIL_PROVIDER overrides; otherwise auto-detect):
 *   ses  → AWS SES (default AWS credential chain; needs EMAIL_FROM + a region)
 *   smtp → any SMTP server via nodemailer (needs EMAIL_FROM + SMTP_HOST)
 *   log  → write to the application log (default when nothing real is configured)
 * Auto order is SES → SMTP → log. A provider that's selected but mis/under-configured falls back to
 * log with a warning rather than failing boot — email must never be a startup blocker.
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

export interface EmailMessage {
    to: string;
    subject: string;
    text: string;
}

export interface EmailTransport {
    readonly name: string;
    send(msg: EmailMessage): Promise<void>;
}

const logger = new Logger('EmailTransport');

/**
 * Dev/CI fallback: never fails, sends nothing. Writes the message (incl. the verification/reset link)
 * to the log so flows are usable with zero setup. In PRODUCTION the body is REDACTED — if a prod
 * deploy ever falls back to log (a misconfigured provider), reset/verification tokens must not land in
 * retained logs. (Production should configure a real provider; the resolver already warns on fallback.)
 */
class LogTransport implements EmailTransport {
    readonly name = 'log';
    async send(msg: EmailMessage): Promise<void> {
        const body =
            process.env.NODE_ENV === 'production'
                ? '[body redacted — link/token withheld; configure a real EMAIL_PROVIDER in production]'
                : msg.text;
        logger.log(`[email:log] to=<${msg.to}> subject="${msg.subject}"\n${body}`);
    }
}

/** AWS SES. Credentials resolve via the default AWS chain (env / IAM role); only region + From here. */
class SesTransport implements EmailTransport {
    readonly name = 'ses';
    private client: import('@aws-sdk/client-ses').SESClient | null = null;
    constructor(private readonly region: string, private readonly from: string) {}
    private async getClient() {
        if (!this.client) {
            const { SESClient } = await import('@aws-sdk/client-ses');
            this.client = new SESClient({ region: this.region });
        }
        return this.client;
    }
    async send(msg: EmailMessage): Promise<void> {
        const { SendEmailCommand } = await import('@aws-sdk/client-ses');
        const client = await this.getClient();
        await client.send(
            new SendEmailCommand({
                Source: this.from,
                Destination: { ToAddresses: [msg.to] },
                Message: { Subject: { Data: msg.subject }, Body: { Text: { Data: msg.text } } },
            }),
        );
    }
}

/** Any SMTP server (SendGrid/Mailgun/Postmark/self-hosted) via nodemailer. */
class SmtpTransport implements EmailTransport {
    readonly name = 'smtp';
    private transporter: import('nodemailer').Transporter | null = null;
    constructor(
        private readonly opts: { host: string; port: number; secure: boolean; user?: string; pass?: string },
        private readonly from: string,
    ) {}
    private async getTransporter() {
        if (!this.transporter) {
            const nodemailer = await import('nodemailer');
            this.transporter = nodemailer.createTransport({
                host: this.opts.host,
                port: this.opts.port,
                secure: this.opts.secure,
                ...(this.opts.user ? { auth: { user: this.opts.user, pass: this.opts.pass } } : {}),
            });
        }
        return this.transporter;
    }
    async send(msg: EmailMessage): Promise<void> {
        const transporter = await this.getTransporter();
        await transporter.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text });
    }
}

/**
 * Resolve the active transport from config. Pure factory — no I/O (SDK clients are created lazily on
 * first send), so this is safe to call at construction time.
 */
export function resolveEmailTransport(config: ConfigService): EmailTransport {
    const provider = (config.get<string>('EMAIL_PROVIDER') ?? 'auto').trim().toLowerCase();
    const from = config.get<string>('EMAIL_FROM')?.trim();
    const region = config.get<string>('SES_REGION')?.trim() || config.get<string>('AWS_REGION')?.trim();
    const smtpHost = config.get<string>('SMTP_HOST')?.trim();

    const ses = (): EmailTransport | null => (from && region ? new SesTransport(region, from) : null);
    const smtp = (): EmailTransport | null => {
        if (!from || !smtpHost) return null;
        const port = Number(config.get<string>('SMTP_PORT')) || 587;
        return new SmtpTransport(
            { host: smtpHost, port, secure: config.get<string>('SMTP_SECURE') === 'true', user: config.get<string>('SMTP_USER'), pass: config.get<string>('SMTP_PASS') },
            from,
        );
    };

    const fallbackToLog = (reason: string): EmailTransport => {
        logger.warn(`EMAIL_PROVIDER="${provider}" requested but ${reason} — falling back to the log transport (no real email will be sent).`);
        return new LogTransport();
    };

    let chosen: EmailTransport;
    if (provider === 'log') {
        chosen = new LogTransport();
    } else if (provider === 'ses') {
        chosen = ses() ?? fallbackToLog('EMAIL_FROM and a region (SES_REGION/AWS_REGION) are required');
    } else if (provider === 'smtp') {
        chosen = smtp() ?? fallbackToLog('EMAIL_FROM and SMTP_HOST are required');
    } else {
        // auto: SES first (the product default), then SMTP, then log.
        chosen = ses() ?? smtp() ?? new LogTransport();
    }

    logger.log(`Email transport: ${chosen.name}${chosen.name === 'log' ? ' (set EMAIL_PROVIDER + EMAIL_FROM to send real email)' : ` (from ${from})`}`);
    return chosen;
}
