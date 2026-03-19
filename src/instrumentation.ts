import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;
export const isSentryEnabled = Boolean(dsn);

if (isSentryEnabled) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? 'production',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '1.0'),
    sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === 'true',
    enableLogs: true,
  });
}

export { Sentry };
