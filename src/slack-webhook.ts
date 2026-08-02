const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

type CallType = 'read' | 'write' | 'destructive' | 'unspecified';

const CALL_TYPE_CONFIG: Record<CallType, { colour: string; emoji: string; label: string }> = {
  destructive: { colour: '#e01e5a', emoji: '🔴', label: 'DESTRUCTIVE' },
  write:       { colour: '#e8a838', emoji: '🟡', label: 'WRITE' },
  read:        { colour: '#2eb886', emoji: '🟢', label: 'READ' },
  unspecified: { colour: '#64748b', emoji: '⚪', label: 'UNSPECIFIED' },
};

export function classifyCallType(_toolOriginalName: string, override?: Exclude<CallType, 'unspecified'>): CallType {
  return override || 'unspecified';
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
  callTypeOverride?: Exclude<CallType, 'unspecified'>;
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
