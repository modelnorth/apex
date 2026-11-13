import type {
  ExtractedOtp,
  InboundPhonePort,
  InboundSmsRequest,
  InboundSmsResponse,
  InboundVoiceCallRequest,
  InboundVoiceResponse,
  PhoneCallProvider,
} from '../../ports/phone-call.ts';
import { untrustedBlock } from '../../shared/untrusted.ts';
import { buildConversationRelayTwiml, verifyTwilioSignature } from './concierge.ts';

export interface InboundPhoneConfig {
  provider?: PhoneCallProvider;
  authToken?: string;
  websocketUrl: string;
  welcomeGreeting?: string;
  maxRecentOtps?: number;
}

interface PendingOtpWaiter {
  senderPattern?: RegExp;
  resolve: (otp: ExtractedOtp) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

const otpRegexWithContext =
  /(?:code|pin|verification|passcode|secret|one-time|otp|token|is)\s*(?:is|:|\-)?\s*(?:[A-Za-z]\-)?\b([0-9]{4,8})\b/i;

const standaloneSixDigits = /\b([0-9]{6})\b/;

const standaloneFourToEightDigits = /\b([0-9]{4,8})\b/;

export function extractOtpFromText(text: string): string | null {
  if (!text || typeof text !== 'string') return null;

  const contextMatch = text.match(otpRegexWithContext);
  if (contextMatch && contextMatch[1]) {
    return contextMatch[1];
  }

  const sixMatch = text.match(standaloneSixDigits);
  if (sixMatch && sixMatch[1]) {
    const num = Number(sixMatch[1]);
    if (num < 190000 || num > 209999) {
      return sixMatch[1];
    }
  }

  const fallbackMatch = text.match(standaloneFourToEightDigits);
  if (fallbackMatch && fallbackMatch[1]) {
    const val = fallbackMatch[1];
    if (val.length === 4) {
      const year = Number(val);
      if (year >= 1990 && year <= 2040) {
        return null;
      }
    }
    return val;
  }

  return null;
}

export class TwilioInboundPhoneService implements InboundPhonePort {
  private readonly provider?: PhoneCallProvider;
  private readonly authToken?: string;
  private readonly websocketUrl: string;
  private readonly welcomeGreeting: string;
  private readonly maxRecentOtps: number;
  private readonly recentOtps: ExtractedOtp[] = [];
  private readonly waiters = new Set<PendingOtpWaiter>();

  constructor(config: InboundPhoneConfig) {
    this.provider = config.provider;
    this.authToken = config.authToken;
    this.websocketUrl = config.websocketUrl;
    this.welcomeGreeting =
      config.welcomeGreeting ?? 'Hello, you have reached your sovereign personal assistant.';
    this.maxRecentOtps = config.maxRecentOtps ?? 50;
  }

  private verifySignature(
    signature?: string,
    url?: string,
    params: Record<string, string> = {},
  ): boolean {
    if (!this.authToken) {
      return true;
    }
    if (!signature || !url) {
      return false;
    }
    if (this.provider?.verifyWebhookSignature) {
      return this.provider.verifyWebhookSignature(signature, url, params);
    }
    return verifyTwilioSignature(this.authToken, signature, url, params);
  }

  async handleInboundVoice(
    request: InboundVoiceCallRequest,
    signature?: string,
    url?: string,
  ): Promise<InboundVoiceResponse> {
    const params: Record<string, string> = {
      CallSid: request.callSid,
      From: request.from,
      To: request.to,
      CallStatus: request.callStatus,
      Direction: request.direction,
    };
    if (request.forwardedFrom) params.ForwardedFrom = request.forwardedFrom;
    if (request.callerName) params.CallerName = request.callerName;

    if (!this.verifySignature(signature, url, params)) {
      throw new Error('Twilio inbound voice signature verification failed');
    }

    const twiml = buildConversationRelayTwiml({
      url: this.websocketUrl,
      welcomeGreeting: this.welcomeGreeting,
      customParameters: {
        callSid: request.callSid,
        from: request.from,
        to: request.to,
      },
    });

    const untrustedPayload = untrustedBlock(
      'twilio_inbound_voice',
      JSON.stringify({
        callSid: request.callSid,
        from: request.from,
        to: request.to,
        status: request.callStatus,
      }),
    );

    return {
      twiml,
      untrustedPayload,
    };
  }

  async handleInboundSms(
    request: InboundSmsRequest,
    signature?: string,
    url?: string,
  ): Promise<InboundSmsResponse> {
    const params: Record<string, string> = {
      MessageSid: request.messageSid,
      From: request.from,
      To: request.to,
      Body: request.body,
    };
    if (request.numSegments) params.NumSegments = request.numSegments;

    if (!this.verifySignature(signature, url, params)) {
      throw new Error('Twilio inbound SMS signature verification failed');
    }

    const code = extractOtpFromText(request.body);
    let otp: ExtractedOtp | undefined;

    if (code) {
      otp = {
        code,
        sender: request.from,
        receivedAt: Date.now(),
        rawMessage: request.body,
      };

      this.recentOtps.unshift(otp);
      if (this.recentOtps.length > this.maxRecentOtps) {
        this.recentOtps.pop();
      }

      for (const waiter of [...this.waiters]) {
        if (!waiter.senderPattern || waiter.senderPattern.test(request.from)) {
          clearTimeout(waiter.timeoutId);
          this.waiters.delete(waiter);
          waiter.resolve(otp);
        }
      }
    }

    const untrustedPayload = untrustedBlock(
      'twilio_inbound_sms',
      JSON.stringify({
        messageSid: request.messageSid,
        from: request.from,
        body: request.body,
        otpCode: code ?? null,
      }),
    );

    return {
      received: true,
      otp,
      untrustedPayload,
    };
  }

  waitForOtp(options: {
    timeoutMs?: number;
    senderPattern?: RegExp;
    signal?: AbortSignal;
  } = {}): Promise<ExtractedOtp> {
    const timeoutMs = options.timeoutMs ?? 60_000;

    return new Promise<ExtractedOtp>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error('Operation aborted'));
        return;
      }

      const timeoutId = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for SMS OTP after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiter: PendingOtpWaiter = {
        senderPattern: options.senderPattern,
        resolve,
        reject,
        timeoutId,
      };

      this.waiters.add(waiter);

      options.signal?.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        this.waiters.delete(waiter);
        reject(new Error('Operation aborted'));
      });
    });
  }

  getRecentOtp(filter: { sender?: string; maxAgeMs?: number } = {}): ExtractedOtp | null {
    const maxAge = filter.maxAgeMs ?? 300_000;
    const now = Date.now();

    for (const otp of this.recentOtps) {
      if (now - otp.receivedAt > maxAge) {
        continue;
      }
      if (filter.sender && !otp.sender.includes(filter.sender)) {
        continue;
      }
      return otp;
    }

    return null;
  }
}

export function createInboundPhoneService(config: InboundPhoneConfig): InboundPhonePort {
  return new TwilioInboundPhoneService(config);
}
