import { describe, expect, it, vi } from 'vitest';
import { FakeEmailSender, MailgunEmailSender } from '../../src/auth/emailSender.js';
import type { MailgunClient } from '../../src/auth/emailSender.js';

function makeFakeMailer(overrides?: Partial<MailgunClient>): MailgunClient {
  return {
    messages: { create: vi.fn().mockResolvedValue(undefined) },
    customMessageLimit: { get: vi.fn().mockResolvedValue({ limit: 3000, current: 5 }) },
    ...overrides,
  };
}

describe('MailgunEmailSender', () => {
  it('sends via the Mailgun client when under the account send limit', async () => {
    const mailer = makeFakeMailer();
    const sender = new MailgunEmailSender('api-key', 'mg.example.com', 'noreply@example.com', mailer);
    await sender.send({ to: 'admin@example.com', subject: 'New registration OTP', text: 'code: 123456' });

    expect(mailer.messages.create).toHaveBeenCalledWith('mg.example.com', {
      from: 'noreply@example.com',
      to: ['admin@example.com'],
      subject: 'New registration OTP',
      text: 'code: 123456',
    });
  });

  it('hard-stops and does not send once the account send limit is reached', async () => {
    const mailer = makeFakeMailer({
      customMessageLimit: { get: vi.fn().mockResolvedValue({ limit: 3000, current: 3000 }) },
    });
    const sender = new MailgunEmailSender('api-key', 'mg.example.com', 'noreply@example.com', mailer);

    await expect(sender.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow(
      'Monthly email quota reached. Please try again later.',
    );
    expect(mailer.messages.create).not.toHaveBeenCalled();
  });

  it('fails open and still sends if the limit check itself errors', async () => {
    const mailer = makeFakeMailer({
      customMessageLimit: { get: vi.fn().mockRejectedValue(new Error('network blip')) },
    });
    const sender = new MailgunEmailSender('api-key', 'mg.example.com', 'noreply@example.com', mailer);

    await sender.send({ to: 'a@b.com', subject: 's', text: 't' });
    expect(mailer.messages.create).toHaveBeenCalledTimes(1);
  });
});

describe('FakeEmailSender', () => {
  it('records sent messages instead of making a network call', async () => {
    const sender = new FakeEmailSender();
    await sender.send({ to: 'a@b.com', subject: 's', text: 't' });
    expect(sender.sent).toEqual([{ to: 'a@b.com', subject: 's', text: 't' }]);
  });
});
