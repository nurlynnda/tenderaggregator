import FormData from 'form-data';
import Mailgun from 'mailgun.js';

export interface EmailSender {
  send(params: { to: string; subject: string; text: string }): Promise<void>;
}

export interface MailgunClient {
  messages: {
    create(domain: string, data: { from: string; to: string[]; subject: string; text: string }): Promise<unknown>;
  };
  customMessageLimit: {
    get(): Promise<{ limit: number; current: number }>;
  };
}

export class MailgunEmailSender implements EmailSender {
  private readonly mailer: MailgunClient;

  constructor(
    apiKey: string,
    private readonly domain: string,
    private readonly fromEmail: string,
    mailerClient?: MailgunClient,
  ) {
    this.mailer = mailerClient ?? (new Mailgun(FormData).client({ username: 'api', key: apiKey }) as unknown as MailgunClient);
  }

  // Mailgun enforces the actual cap account-side; this is a pre-check so an exhausted
  // quota surfaces as a clean error instead of a raw send failure. If the limit check
  // itself errors (network blip, or no custom limit configured yet), fail open and let
  // the send attempt proceed.
  private async checkSendLimit(): Promise<void> {
    let usage;
    try {
      usage = await this.mailer.customMessageLimit.get();
    } catch (err) {
      console.warn(`Could not verify Mailgun send limit, proceeding anyway: ${err}`);
      return;
    }
    if (usage.current >= usage.limit) {
      throw new Error('Monthly email quota reached. Please try again later.');
    }
  }

  async send(params: { to: string; subject: string; text: string }): Promise<void> {
    await this.checkSendLimit();
    await this.mailer.messages.create(this.domain, {
      from: this.fromEmail,
      to: [params.to],
      subject: params.subject,
      text: params.text,
    });
  }
}

export class FakeEmailSender implements EmailSender {
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];

  async send(params: { to: string; subject: string; text: string }): Promise<void> {
    this.sent.push(params);
  }
}
