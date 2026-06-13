import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import type { EmailTransport } from './email-transports';

const cfg = (vals: Record<string, string> = {}) => ({ get: (k: string) => vals[k] }) as unknown as ConfigService;

describe('EmailService', () => {
    it('builds verification/reset links against APP_URL (trailing slash trimmed, token encoded)', () => {
        const svc = new EmailService(cfg({ APP_URL: 'https://app.cf.io/' }));
        expect(svc.verificationLink('a b/c')).toBe('https://app.cf.io/verify-email?token=a%20b%2Fc');
        expect(svc.passwordResetLink('tok')).toBe('https://app.cf.io/reset-password?token=tok');
    });

    it('defaults APP_URL to localhost when unset', () => {
        const svc = new EmailService(cfg({}));
        expect(svc.verificationLink('t')).toBe('http://localhost:3000/verify-email?token=t');
    });

    it('is best-effort: a transport failure is swallowed so the auth flow is not broken', async () => {
        const svc = new EmailService(cfg({})); // log transport
        // Replace the resolved transport with one that throws.
        const boom: EmailTransport = { name: 'boom', send: jest.fn(async () => { throw new Error('SES down'); }) };
        (svc as unknown as { transport: EmailTransport }).transport = boom;
        await expect(svc.sendVerificationEmail('u@x.com', 'tok')).resolves.toBeUndefined();
        await expect(svc.sendPasswordResetEmail('u@x.com', 'tok')).resolves.toBeUndefined();
        expect(boom.send).toHaveBeenCalledTimes(2);
    });

    it('log transport redacts the link/token in production, shows it otherwise', async () => {
        const { resolveEmailTransport } = require('./email-transports');
        const log = jest.spyOn(require('@nestjs/common').Logger.prototype, 'log').mockImplementation(() => undefined);
        const t = resolveEmailTransport(cfg({})); // log transport
        const prev = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = 'production';
            await t.send({ to: 'u@x.com', subject: 's', text: 'click https://app/reset?token=SECRET' });
            expect(log).toHaveBeenCalledWith(expect.stringContaining('redacted'));
            expect(log).not.toHaveBeenCalledWith(expect.stringContaining('SECRET'));
            log.mockClear();
            process.env.NODE_ENV = 'development';
            await t.send({ to: 'u@x.com', subject: 's', text: 'click https://app/reset?token=SECRET' });
            expect(log).toHaveBeenCalledWith(expect.stringContaining('SECRET'));
        } finally {
            process.env.NODE_ENV = prev;
            log.mockRestore();
        }
    });

    it('delegates to the active transport with the rendered message', async () => {
        const svc = new EmailService(cfg({ APP_URL: 'https://cf.io' }));
        const sent: { to: string; subject: string; text: string }[] = [];
        (svc as unknown as { transport: EmailTransport }).transport = { name: 'capture', send: async (m) => { sent.push(m); } };
        await svc.sendVerificationEmail('u@x.com', 'TK');
        expect(sent[0]!.to).toBe('u@x.com');
        expect(sent[0]!.subject).toMatch(/verify/i);
        expect(sent[0]!.text).toContain('https://cf.io/verify-email?token=TK');
    });
});
