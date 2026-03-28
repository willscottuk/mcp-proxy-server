const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

type CallType = 'read' | 'write' | 'destructive';

const DESTRUCTIVE_PREFIXES = [
  'delete', 'remove', 'destroy', 'drop', 'purge', 'truncate',
  'wipe', 'terminate', 'kill', 'revoke', 'force', 'reset', 'disable', 'cancel',
];

const READ_PREFIXES = [
  'get', 'list', 'read', 'fetch', 'search', 'find', 'describe',
  'show', 'view', 'check', 'inspect', 'stat', 'info', 'lookup',
  'query', 'browse', 'ping', 'validate',
];

const CALL_TYPE_CONFIG: Record<CallType, { colour: string; emoji: string; label: string }> = {
  destructive: { colour: '#e01e5a', emoji: '🔴', label: 'DESTRUCTIVE' },
  write:       { colour: '#e8a838', emoji: '🟡', label: 'WRITE' },
  read:        { colour: '#2eb886', emoji: '🟢', label: 'READ' },
};

export function classifyCallType(toolOriginalName: string, override?: CallType): CallType {
  if (override) return override;
  const lower = toolOriginalName.toLowerCase();
  if (DESTRUCTIVE_PREFIXES.some(p => lower === p || lower.startsWith(`${p}_`) || lower.startsWith(`${p}-`))) {
    return 'destructive';
  }
  if (READ_PREFIXES.some(p => lower === p || lower.startsWith(`${p}_`) || lower.startsWith(`${p}-`))) {
    return 'read';
  }
  return 'write';
}

export interface SlackNotifyParams {
  toolExposedName: string;
  toolOriginalName: string;
  serverKey: string;
  transportType: string;
  args: Record<string, unknown>;
  success: boolean;
  errorMessage?: string;
  durationMs: number;
  callTypeOverride?: CallType;
}

export async function sendToolCallNotification(params: SlackNotifyParams): Promise<void> {
  if (!SLACK_WEBHOOK_URL) return;

  const { toolExposedName, toolOriginalName, serverKey, transportType, args, success, errorMessage, durationMs, callTypeOverride } = params;
  const callType = classifyCallType(toolOriginalName, callTypeOverride);
  const { colour, emoji, label } = CALL_TYPE_CONFIG[callType];

  const statusText = success
    ? `✅ Success  _(${durationMs}ms)_`
    : `❌ Failed  _(${durationMs}ms)_`;

  const argsJson = JSON.stringify(args, null, 2);
  const truncated = argsJson.length > 2000 ? argsJson.slice(0, 2000) + '\n… (truncated)' : argsJson;

  const body: Record<string, unknown> = {
    attachments: [
      {
        color: colour,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `${emoji} ${label}  |  ${toolExposedName}`, emoji: true },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Server:* ${serverKey}  _(${transportType})_` },
              { type: 'mrkdwn', text: `*Status:* ${statusText}` },
              ...(toolExposedName !== toolOriginalName
                ? [{ type: 'mrkdwn', text: `*Backend tool:* \`${toolOriginalName}\`` }]
                : []),
              ...(errorMessage
                ? [{ type: 'mrkdwn', text: `*Error:* ${errorMessage}` }]
                : []),
            ],
          },
        ],
      },
      {
        color: colour,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Request Arguments*\n\`\`\`${truncated}\`\`\`` },
          },
        ],
      },
    ],
  };

  await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
