/**
 * Email template unit tests — the templates are pure functions ({subject, text, html}), so this needs no
 * app/DB. Proves each email carries the link in BOTH a plaintext and an HTML part, and that interpolated
 * values (org/user names, links) are HTML-escaped in the HTML body so a name containing angle brackets,
 * ampersands or quotes can never break the surrounding markup.
 */
import { escapeHtml, verificationEmail, passwordResetEmail, orgInviteEmail } from '../src/email/templates';

describe('email templates', () => {
    const link = 'https://app.circuitforge.io/verify?token=abc123&x=1';

    it('escapeHtml neutralizes every HTML-significant character', () => {
        expect(escapeHtml(`Tom & Jerry <Labs> "Q" 'x'`)).toBe('Tom &amp; Jerry &lt;Labs&gt; &quot;Q&quot; &#39;x&#39;');
    });

    it('verification email: subject + plaintext + HTML all carry the link; HTML is a real document', () => {
        const m = verificationEmail(link);
        expect(m.subject).toMatch(/verify/i);
        expect(m.text).toContain(link);
        expect(m.text).toMatch(/24 hours/);
        expect(m.html).toContain('<!doctype html');
        expect(m.html).toContain('Verify email'); // the CTA button
        // the link appears in an href, with & encoded as &amp; (valid HTML attribute encoding)
        expect(m.html).toContain(link.replace(/&/g, '&amp;'));
    });

    it('password reset email carries the link in text + HTML with the 1-hour notice', () => {
        const m = passwordResetEmail(link);
        expect(m.subject).toMatch(/reset/i);
        expect(m.text).toContain(link);
        expect(m.text).toMatch(/1 hour/);
        expect(m.html).toContain(link.replace(/&/g, '&amp;'));
        expect(m.html).toContain('<!doctype html');
    });

    it('invite email includes org + inviter in subject/text/html', () => {
        const m = orgInviteEmail(link, 'Acme Robotics', 'Ada Lovelace');
        expect(m.subject).toContain('Acme Robotics');
        expect(m.text).toContain('Ada Lovelace');
        expect(m.text).toContain('Acme Robotics');
        expect(m.text).toContain(link);
        expect(m.html).toContain('Acme Robotics');
        expect(m.html).toContain('Accept invitation');
    });

    it('special characters in an org/inviter name are escaped in the HTML body (markup stays intact)', () => {
        const m = orgInviteEmail(link, 'R&D <Team>', 'A "Quoted" Name');
        // the raw angle-bracket form must NOT appear in the HTML...
        expect(m.html).not.toContain('<Team>');
        // ...only its escaped form
        expect(m.html).toContain('R&amp;D &lt;Team&gt;');
        expect(m.html).toContain('A &quot;Quoted&quot; Name');
        // plaintext is not markup, so it keeps the raw name unchanged
        expect(m.text).toContain('R&D <Team>');
    });
});
