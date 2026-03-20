// Sentry preload file — must be loaded via `--import` before any other modules.
// Kept minimal intentionally: no exports, no extra imports, so that OTel module
// hooks are registered before express (or any other library) is first imported.
import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? 'production',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '1.0'),
    sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === 'true',
    enableLogs: true,
  });
}
