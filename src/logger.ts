type BreadcrumbSink = (level: string, message: string) => void;
type McpNotificationSink = (level: string, message: string) => void;

const breadcrumbSinks: BreadcrumbSink[] = [];
const mcpNotificationSinks: McpNotificationSink[] = [];

export function addBreadcrumbSink(sink: BreadcrumbSink): void {
  breadcrumbSinks.push(sink);
}

export function addMcpNotificationSink(sink: McpNotificationSink): void {
  mcpNotificationSinks.push(sink);
}

function formatArgsForSink(...args: any[]): string {
  return args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

function formatTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  const milliseconds = now.getMilliseconds().toString().padStart(3, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

enum LogLevel {
  Error,
  Warn,
  Info,
  Debug,
}

function getLogLevel(envVar: string | undefined): LogLevel {
  switch (envVar?.toLowerCase()) {
    case 'debug':
      return LogLevel.Debug;
    case 'info':
      return LogLevel.Info;
    case 'warn':
      return LogLevel.Warn;
    case 'error':
      return LogLevel.Error;
    default:
      return LogLevel.Info; // Default to Info level
  }
}

const currentLogLevel = getLogLevel(process.env.LOGGING);

function log(...args: any[]): void {
  if (currentLogLevel >= LogLevel.Info) {
    console.log(`[${formatTimestamp()}] [INFO]`, ...args);
  }
  const msg = formatArgsForSink(...args);
  breadcrumbSinks.forEach(s => s('info', msg));
}

function warn(...args: any[]): void {
  if (currentLogLevel >= LogLevel.Warn) {
    console.warn(`[${formatTimestamp()}] [WARN]`, ...args);
  }
  const msg = formatArgsForSink(...args);
  breadcrumbSinks.forEach(s => s('warning', msg));
  mcpNotificationSinks.forEach(s => s('warning', msg));
}

function error(...args: any[]): void {
  if (currentLogLevel >= LogLevel.Error) {
    console.error(`[${formatTimestamp()}] [ERROR]`, ...args);
  }
  const msg = formatArgsForSink(...args);
  breadcrumbSinks.forEach(s => s('error', msg));
  mcpNotificationSinks.forEach(s => s('error', msg));
}

function debug(...args: any[]): void {
  if (currentLogLevel >= LogLevel.Debug) {
    console.debug(`[${formatTimestamp()}] [DEBUG]`, ...args);
  }
  const msg = formatArgsForSink(...args);
  breadcrumbSinks.forEach(s => s('debug', msg));
}

export const logger = {
  log,
  warn,
  error,
  debug,
};
