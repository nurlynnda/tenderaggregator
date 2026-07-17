export interface EmailSender {
  send(params: { to: string; subject: string; text: string }): Promise<void>;
}

export class MailerSendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly fromEmail: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(params: { to: string; subject: string; text: string }): Promise<void> {
    const res = await this.fetchImpl('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: { email: this.fromEmail },
        to: [{ email: params.to }],
        subject: params.subject,
        text: params.text,
      }),
    });
    if (!res.ok) throw new Error(`MailerSend request failed: ${res.status}`);
  }
}

export class FakeEmailSender implements EmailSender {
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];

  async send(params: { to: string; subject: string; text: string }): Promise<void> {
    this.sent.push(params);
  }
}
