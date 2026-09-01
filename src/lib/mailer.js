const { Resend } = require('resend');

// Lazy so the app still boots (and /healthz still answers) without a key set.
let _resend = null;
function client() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('Mail delivery is not configured yet. Add RESEND_API_KEY.');
  }
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}
const resend = {
  get emails() { return client().emails; },
  get domains() { return client().domains; },
};

const FROM_OTP = process.env.OTP_FROM || `LSPMail <login@${process.env.MAIL_DOMAIN || 'lspmail.app'}>`;

async function sendMail({ from, to, cc, subject, text, html, replyTo, attachments }) {
  const hasText = typeof text === 'string' && text.length > 0;
  const hasHtml = typeof html === 'string' && html.length > 0;

  // Resend requires at least one body field. A subject-only message is a normal
  // thing to send, so fall back to a newline rather than refusing it.
  const payload = {
    from,
    to: Array.isArray(to) ? to : [to],
    cc: cc && cc.length ? cc : undefined,
    subject: subject || '(no subject)',
    replyTo: replyTo || undefined,
    attachments: attachments && attachments.length
      ? attachments.map((a) => ({ filename: a.filename, content: a.content }))
      : undefined,
  };
  if (hasHtml) payload.html = html;
  if (hasText || !hasHtml) payload.text = hasText ? text : '\n';

  const { data, error } = await client().emails.send(payload);
  if (error) throw new Error(error.message || 'Resend rejected the message');
  return data;
}

function otpEmail(code) {
  return `<!doctype html><html><body style="margin:0;background:#F6F6F4;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:48px 16px">
    <table width="440" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #E4E4DE;border-radius:16px">
      <tr><td style="padding:36px 36px 8px">
        <div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#6E6E66">LSPMail</div>
        <h1 style="margin:14px 0 6px;font-size:22px;color:#1B1B18;font-weight:650">Your sign-in code</h1>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#6E6E66">Enter this code to finish signing in. It expires in 10 minutes.</p>
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:34px;letter-spacing:.34em;color:#1B1B18;background:#F6F6F4;border:1px solid #E4E4DE;border-radius:12px;padding:18px 0;text-align:center">${code}</div>
        <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#9A9A90">Didn't ask for this? Ignore the message and nothing will change.</p>
      </td></tr>
      <tr><td style="padding:28px 36px 32px"><div style="border-top:1px solid #E4E4DE;padding-top:16px;font-size:12px;color:#9A9A90">Sent by LSPMail</div></td></tr>
    </table>
  </td></tr></table></body></html>`;
}

async function sendOtp(email, code) {
  return sendMail({
    from: FROM_OTP,
    to: email,
    subject: `${code} is your LSPMail sign-in code`,
    text: `Your LSPMail sign-in code is ${code}. It expires in 10 minutes.`,
    html: otpEmail(code),
  });
}

module.exports = { resend, sendMail, sendOtp };
