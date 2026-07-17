import { describe, expect, it, vi } from 'vitest';
import { FakeEmailSender, MailerSendEmailSender } from '../../src/auth/emailSender.js';

describe('MailerSendEmailSender', () => {
  it('POSTs to the MailerSend API with the right auth header and body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const sender = new MailerSendEmailSender('secret-key', 'noreply@example.com', fetchImpl as unknown as typeof fetch);
    await sender.send({ to: 'admin@example.com', subject: 'New registration OTP', text: 'code: 123456' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.mailersend.com/v1/email',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret-key' }),
      }),
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      from: { email: 'noreply@example.com' },
      to: [{ email: 'admin@example.com' }],
      subject: 'New registration OTP',
      text: 'code: 123456',
    });
  });

  it('throws when MailerSend responds with a non-ok status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const sender = new MailerSendEmailSender('bad-key', 'noreply@example.com', fetchImpl as unknown as typeof fetch);
    await expect(sender.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow('MailerSend request failed: 401');
  });
});

describe('FakeEmailSender', () => {
  it('records sent messages instead of making a network call', async () => {
    const sender = new FakeEmailSender();
    await sender.send({ to: 'a@b.com', subject: 's', text: 't' });
    expect(sender.sent).toEqual([{ to: 'a@b.com', subject: 's', text: 't' }]);
  });
});
