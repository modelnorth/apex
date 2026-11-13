export class PhoneCallApprovalError extends Error {
  readonly statusCode = 403;
}

export class PhoneCallProviderError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface PlaceCallRequest {
  approvalId?: string;
  approved: boolean;
  to: string;
  reason: string;
  welcomeGreeting?: string;
  voice?: string;
  metadata?: Record<string, string>;
}

export interface PhoneCallResult {
  callSid: string;
  status: string;
  to: string;
  from: string;
  approvalId: string;
  createdAt?: string;
}

export interface ConversationRelayConfig {
  url: string;
  welcomeGreeting?: string;
  welcomeGreetingInterruptible?: boolean;
  language?: string;
  ttsProvider?: string;
  voice?: string;
  transcriptionProvider?: string;
  speechModel?: string;
  interruptible?: boolean;
  dtmfDetection?: boolean;
  hints?: string;
  customParameters?: Record<string, string>;
}

export type ConversationRelaySetupEvent = {
  type: 'setup';
  sessionId?: string;
  callSid?: string;
  accountSid?: string;
  from?: string;
  to?: string;
  direction?: string;
  customParameters?: Record<string, string>;
};

export type ConversationRelayPromptEvent = {
  type: 'prompt';
  voicePrompt: string;
  lang?: string;
  last?: boolean;
};

export type ConversationRelayInterruptEvent = {
  type: 'interrupt';
  utteranceUntilInterrupt?: string;
  durationUntilInterruptMs?: number;
};

export type ConversationRelayDtmfEvent = {
  type: 'dtmf';
  digit: string;
};

export type ConversationRelayErrorEvent = {
  type: 'error';
  description: string;
  code?: string;
};

export type ConversationRelayInbound =
  | ConversationRelaySetupEvent
  | ConversationRelayPromptEvent
  | ConversationRelayInterruptEvent
  | ConversationRelayDtmfEvent
  | ConversationRelayErrorEvent;

export type ConversationRelayTextOutbound = {
  type: 'text';
  token: string;
  last: boolean;
  interruptible?: boolean;
  preemptible?: boolean;
  lang?: string;
};

export type ConversationRelayOutbound =
  | ConversationRelayTextOutbound
  | {
      type: 'end';
      handoffData?: string;
    }
  | {
      type: 'sendDigits';
      digits: string;
    }
  | {
      type: 'language';
      ttsLanguage?: string;
      transcriptionLanguage?: string;
    }
  | {
      type: 'play';
      source: string;
      loop?: number;
      interruptible?: boolean;
      preemptible?: boolean;
    };

export type ConversationRelayPromptHandler = (
  prompt: ConversationRelayPromptEvent,
  context: { raw: ConversationRelayInbound },
) =>
  | Promise<string | ConversationRelayOutbound | void>
  | string
  | ConversationRelayOutbound
  | void;

export interface ConversationRelayHandleOptions {
  emit?: (message: ConversationRelayOutbound) => Promise<void> | void;
  onEvent?: (event: ConversationRelayInbound) => Promise<void> | void;
}

export interface PhoneCallPort {
  placeCall(request: PlaceCallRequest, signal?: AbortSignal): Promise<PhoneCallResult>;
  buildTwiml?(config: ConversationRelayConfig): string;
}

export interface PhoneCallProvider extends PhoneCallPort {
  id: string;
  configured: boolean;
  buildTwiml(config: ConversationRelayConfig): string;
  verifyWebhookSignature(
    signature: string,
    url: string,
    params: Record<string, string>,
  ): boolean;
  handleRelayMessage(
    rawMessage: string | Uint8Array | Buffer,
    onPrompt: ConversationRelayPromptHandler,
    options?: ConversationRelayHandleOptions,
  ): Promise<ConversationRelayOutbound | null>;
}

export interface InboundVoiceCallRequest {
  callSid: string;
  from: string;
  to: string;
  callStatus: string;
  direction: 'inbound';
  forwardedFrom?: string;
  callerName?: string;
}

export interface InboundSmsRequest {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  numSegments?: string;
}

export interface ExtractedOtp {
  code: string;
  sender: string;
  receivedAt: number;
  rawMessage: string;
}

export interface InboundVoiceResponse {
  twiml: string;
  untrustedPayload: string;
}

export interface InboundSmsResponse {
  received: boolean;
  otp?: ExtractedOtp;
  untrustedPayload: string;
}

export interface InboundPhonePort {
  handleInboundVoice(
    request: InboundVoiceCallRequest,
    signature?: string,
    url?: string,
  ): Promise<InboundVoiceResponse>;
  handleInboundSms(
    request: InboundSmsRequest,
    signature?: string,
    url?: string,
  ): Promise<InboundSmsResponse>;
  waitForOtp(options?: {
    timeoutMs?: number;
    senderPattern?: RegExp;
    signal?: AbortSignal;
  }): Promise<ExtractedOtp>;
  getRecentOtp(filter?: { sender?: string; maxAgeMs?: number }): ExtractedOtp | null;
}
