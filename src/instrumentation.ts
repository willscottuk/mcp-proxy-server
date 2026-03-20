import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { createRequire } from 'module';
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const dsn = process.env.SENTRY_DSN;
export const isSentryEnabled = Boolean(dsn);

// In SSE mode, instrument.ts is pre-loaded via --import and calls Sentry.init()
// before express is imported. Here we only init if that hasn't happened yet
// (e.g. stdio mode, where --import is not used).
if (isSentryEnabled && !Sentry.getClient()) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? 'production',
    release: process.env.SENTRY_RELEASE ?? version,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '1.0'),
    sendDefaultPii: true,
    includeLocalVariables: true,
    enableLogs: true,
    integrations: [nodeProfilingIntegration()],
    profileSessionSampleRate: Number(process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE ?? '1.0'),
    profileLifecycle: 'trace',
  });
}

export { Sentry };
