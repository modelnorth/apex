import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  PhoneCallApprovalError,
  PhoneCallProviderError,
  type ConversationRelayConfig,
  type ConversationRelayHandleOptions,
  type ConversationRelayInbound,
  type ConversationRelayOutbound,
  type ConversationRelayPromptHandler,
  type PhoneCallProvider,
  type PhoneCallResult,
  type PlaceCallRequest,
} from '../../ports/phone-call.ts';

export interface TwilioConciergeConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  webhookBaseUrl: string;
  fetchImpl?: typeof fetch;
  twimlPath?: string;
}

const inboundEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('setup'),
    sessionId: z.string().optional(),
    callSid: z.string().optional(),
    accountSid: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    direction: z.string().optional(),
    customParameters: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal('prompt'),
    voicePrompt: z.string(),
    lang: z.string().optional(),
    last: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('interrupt'),
    utteranceUntilInterrupt: z.string().optional(),
    durationUntilInterruptMs: z.number().optional(),
  }),
  z.object({
    type: z.literal('dtmf'),
    digit: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    description: z.string(),
    code: z.string().optional(),
  }),
]);

const twilioCallResponseSchema = z.object({
  sid: z.string().min(1),
  status: z.string().optional(),
  to: z.string().optional(),
  from: z.string().optional(),
  date_created: z.string().optional(),
});

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatAttribute(name: string, value: string | boolean | undefined): string | null {
  if (value === undefined) return null;
  const serialized = typeof value === 'boolean' ? (value ? 'true' : 'false') : value;
  return `${name}="${escapeXmlAttribute(serialized)}"`;
}

export function buildConversationRelayTwiml(config: ConversationRelayConfig): string {
  if (!config.url || config.url.trim().length === 0) {
    throw new PhoneCallProviderError('ConversationRelay url is required.', 400);
  }
  const attributes = [
    formatAttribute('url', config.url),
    formatAttribute('welcomeGreeting', config.welcomeGreeting),
    formatAttribute('welcomeGreetingInterruptible', config.welcomeGreetingInterruptible),
    formatAttribute('language', config.language),
    formatAttribute('ttsProvider', config.ttsProvider ?? 'ElevenLabs'),
    formatAttribute('voice', config.voice),
    formatAttribute('transcriptionProvider', config.transcriptionProvider ?? 'Deepgram'),
    formatAttribute('speechModel', config.speechModel),
    formatAttribute('interruptible', config.interruptible),
    formatAttribute('dtmfDetection', config.dtmfDetection),
    formatAttribute('hints', config.hints),
  ].filter((entry): entry is string => entry !== null);

  const customEntries = config.customParameters ? Object.entries(config.customParameters) : [];
  if (customEntries.length === 0) {
    return `<Response><Connect><ConversationRelay ${attributes.join(' ')}/></Connect></Response>`;
  }
  const parameters = customEntries
    .map(
      ([name, value]) =>
        `<Parameter ${formatAttribute('name', name)} ${formatAttribute('value', value)}/>`,
    )
    .join('');
  return `<Response><Connect><ConversationRelay ${attributes.join(' ')}>${parameters}</ConversationRelay></Connect></Response>`;
}

export function verifyTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!authToken || !signature || !url) return false;
  const sortedKeys = Object.keys(params).sort();
  let payload = url;
  for (const key of sortedKeys) {
    payload += key + params[key];
  }
  const expected = createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(signature, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function parseConversationRelayMessage(
  rawMessage: string | Uint8Array | Buffer,
): ConversationRelayInbound {
  const text =
    typeof rawMessage === 'string' ? rawMessage : Buffer.from(rawMessage).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PhoneCallProviderError('Invalid ConversationRelay JSON payload.', 400);
  }
  const result = inboundEventSchema.safeParse(parsed);
  if (!result.success) {
    throw new PhoneCallProviderError('Unsupported ConversationRelay event payload.', 400);
  }
  return result.data;
}

export function createTwilioConciergeProvider(config: TwilioConciergeConfig): PhoneCallProvider {
  const {
    accountSid,
    authToken,
    fromNumber,
    webhookBaseUrl,
    fetchImpl = fetch,
    twimlPath = '/twiml',
  } = config;
  const configured = Boolean(
    accountSid.trim() && authToken.trim() && fromNumber.trim() && webhookBaseUrl.trim(),
  );

  function buildWebhookUrl(request: PlaceCallRequest): string {
    const normalizedBase = webhookBaseUrl.replace(/\/+$/, '');
    const normalizedPath = twimlPath.startsWith('/') ? twimlPath : `/${twimlPath}`;
    const url = new URL(`${normalizedBase}${normalizedPath}`);
    if (request.approvalId) url.searchParams.set('approvalId', request.approvalId);
    if (request.welcomeGreeting) url.searchParams.set('welcomeGreeting', request.welcomeGreeting);
    if (request.voice) url.searchParams.set('voice', request.voice);
    return url.toString();
  }

  return {
    id: 'twilio-concierge',
    configured,
    buildTwiml: buildConversationRelayTwiml,
    verifyWebhookSignature(signature, url, params) {
      return verifyTwilioSignature(authToken, signature, url, params);
    },
    async placeCall(request: PlaceCallRequest, signal?: AbortSignal): Promise<PhoneCallResult> {
      if (
        request.approved !== true ||
        typeof request.approvalId !== 'string' ||
        request.approvalId.trim().length === 0
      ) {
        throw new PhoneCallApprovalError(
          'Outbound phone calls require explicit approval and a valid approvalId.',
        );
      }
      if (!configured) {
        throw new PhoneCallProviderError('Twilio concierge provider is not configured.', 400);
      }
      if (!request.to || request.to.trim().length === 0) {
        throw new PhoneCallProviderError('Destination phone number is required.', 400);
      }
      if (!request.reason || request.reason.trim().length === 0) {
        throw new PhoneCallProviderError('Call reason is required.', 400);
      }
      signal?.throwIfAborted();

      const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`;
      const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`, 'utf8').toString('base64')}`;
      const body = new URLSearchParams({
        To: request.to,
        From: fromNumber,
        Url: buildWebhookUrl(request),
      });

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new PhoneCallProviderError(
          `Twilio Calls API failed with status ${response.status}${errorText ? `: ${errorText}` : ''}`,
          response.status >= 400 && response.status < 600 ? response.status : 502,
        );
      }

      const rawJson = await response.json();
      const parsed = twilioCallResponseSchema.safeParse(rawJson);
      if (!parsed.success) {
        throw new PhoneCallProviderError('Invalid response from Twilio Calls API.', 502);
      }

      return {
        callSid: parsed.data.sid,
        status: parsed.data.status ?? 'queued',
        to: parsed.data.to ?? request.to,
        from: parsed.data.from ?? fromNumber,
        approvalId: request.approvalId,
        createdAt: parsed.data.date_created,
      };
    },
    async handleRelayMessage(
      rawMessage: string | Uint8Array | Buffer,
      onPrompt: ConversationRelayPromptHandler,
      options?: ConversationRelayHandleOptions,
    ): Promise<ConversationRelayOutbound | null> {
      const event = parseConversationRelayMessage(rawMessage);
      if (options?.onEvent) {
        await options.onEvent(event);
      }
      if (event.type !== 'prompt') {
        return null;
      }
      const reply = await onPrompt(event, { raw: event });
      if (reply === undefined || reply === null) {
        return null;
      }
      const outbound: ConversationRelayOutbound =
        typeof reply === 'string'
          ? { type: 'text', token: reply, last: true }
          : reply;
      if (options?.emit) {
        await options.emit(outbound);
      }
      return outbound;
    },
  };
}
