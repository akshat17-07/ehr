import { env, requireEnv } from '../config/env.js';

// Plain-text emails through Amazon SES (ap-south-1). Used only for record-copy share links and their one-time codes;
// nothing else is emailed.

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export const sesMailer: Mailer = {
  async send({ to, subject, text }) {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const client = new SESv2Client({ region: env.AWS_REGION });
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: requireEnv('MAIL_FROM'),
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } },
      }),
    );
  },
};
