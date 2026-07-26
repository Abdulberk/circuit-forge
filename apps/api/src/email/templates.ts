/**
 * Email content templates — pure functions returning { subject, text, html }. Content lives HERE, apart
 * from delivery (EmailService) and the provider (transports). Every message has a plaintext part AND an
 * HTML part built from one shared branded layout. HTML uses table layout + INLINE styles (email clients
 * strip <style>/external CSS) and a light background (the most deliverable/compatible choice — the app UI
 * is dark-first, but transactional email convention is light). English-only for v1. Every interpolated
 * value (links, org/user names) is HTML-escaped — names come from user data and must never break the markup.
 */

export interface EmailContent {
    subject: string;
    text: string;
    html: string;
}

const BRAND = 'Circuit Forge';
const C = {
    page: '#f4f6f8',
    card: '#ffffff',
    border: '#e6e9ee',
    heading: '#0f172a',
    body: '#334155',
    muted: '#94a3b8',
    accent: '#0ea5b7', // teal — the brand accent, used for links + the CTA button
    buttonText: '#ffffff',
};

/** Escape the five HTML-significant characters so interpolated values can't break (or inject) markup. */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * One branded HTML shell for every email. `paragraphs` are the body lines (plain strings — escaped here);
 * an optional CTA button + a raw fallback link; an optional muted footnote. Returns a full HTML document.
 */
function layout(opts: {
    heading: string;
    paragraphs: string[];
    button?: { label: string; url: string };
    footnote?: string;
}): string {
    const bodyParas = opts.paragraphs
        .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${C.body};">${escapeHtml(p)}</p>`)
        .join('');

    const button = opts.button
        ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;">
             <tr><td style="border-radius:8px;background:${C.accent};">
               <a href="${escapeHtml(opts.button.url)}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:${C.buttonText};text-decoration:none;border-radius:8px;">${escapeHtml(opts.button.label)}</a>
             </td></tr>
           </table>
           <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${C.muted};">Or paste this link into your browser:<br/>
             <a href="${escapeHtml(opts.button.url)}" style="color:${C.accent};word-break:break-all;">${escapeHtml(opts.button.url)}</a>
           </p>`
        : '';

    const footnote = opts.footnote
        ? `<p style="margin:0;font-size:13px;line-height:1.5;color:${C.muted};">${escapeHtml(opts.footnote)}</p>`
        : '';

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(opts.heading)}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${C.card};border:1px solid ${C.border};border-radius:12px;overflow:hidden;">
        <tr><td style="padding:22px 28px;border-bottom:1px solid ${C.border};">
          <span style="font-size:17px;font-weight:700;color:${C.heading};letter-spacing:-0.01em;">⚡ ${escapeHtml(BRAND)}</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:${C.heading};">${escapeHtml(opts.heading)}</h1>
          ${bodyParas}
          ${button}
          ${footnote}
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid ${C.border};">
          <p style="margin:0;font-size:12px;line-height:1.5;color:${C.muted};">${escapeHtml(BRAND)} — AI-assisted circuit design, verified by real SPICE.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function verificationEmail(link: string): EmailContent {
    return {
        subject: `Verify your ${BRAND} email`,
        text: `Welcome to ${BRAND}. Confirm your email address:\n${link}\n(This link expires in 24 hours.)`,
        html: layout({
            heading: `Confirm your email`,
            paragraphs: [`Welcome to ${BRAND}. Confirm your email address to finish setting up your account.`],
            button: { label: 'Verify email', url: link },
            footnote: 'This link expires in 24 hours.',
        }),
    };
}

export function passwordResetEmail(link: string): EmailContent {
    return {
        subject: `Reset your ${BRAND} password`,
        text: `We received a request to reset your password. If it was you, choose a new one:\n${link}\n(This link expires in 1 hour. If it wasn't you, ignore this email.)`,
        html: layout({
            heading: `Reset your password`,
            paragraphs: [
                `We received a request to reset your ${BRAND} password. If it was you, choose a new one below.`,
            ],
            button: { label: 'Choose a new password', url: link },
            footnote: "This link expires in 1 hour. If it wasn't you, you can safely ignore this email.",
        }),
    };
}

export function orgInviteEmail(link: string, orgName: string, inviterName: string): EmailContent {
    return {
        subject: `You've been invited to join ${orgName} on ${BRAND}`,
        text: `${inviterName} invited you to join the "${orgName}" organization on ${BRAND}.\nAccept the invitation:\n${link}\n(This link expires in 7 days. If you weren't expecting this, you can safely ignore this email.)`,
        html: layout({
            heading: `Join ${orgName} on ${BRAND}`,
            paragraphs: [`${inviterName} invited you to join the “${orgName}” organization on ${BRAND}.`],
            button: { label: 'Accept invitation', url: link },
            footnote: "This link expires in 7 days. If you weren't expecting this, you can safely ignore this email.",
        }),
    };
}
