import type { BrowserAction, BrowserObservation } from './computer.ts';

export type StealthBrowserMode = 'local' | 'remote';

export type AntiBotChallengeKind = 'none' | 'captcha' | 'cloudflare' | 'bot_block';

export interface AntiBotDetection {
  challenge: AntiBotChallengeKind;
  escalateToRemote: boolean;
}

export interface StealthSessionOptions {
  session?: string;
  mode?: StealthBrowserMode;
  verified?: boolean;
  proxies?: boolean;
  chromePath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StealthExecutionResult {
  observation: BrowserObservation;
  title?: string;
  mode: StealthBrowserMode;
  session: string;
  challenge: AntiBotChallengeKind;
  escalateToRemote: boolean;
  escalated?: boolean;
  escalatedFromChallenge?: AntiBotChallengeKind;
  escalationReason?: string;
  rawOutput: string;
}

export interface StealthDoctorResult {
  ok: boolean;
  mode: StealthBrowserMode;
  output: string;
  chromePath?: string;
  remoteAvailable: boolean;
}

export interface StealthBrowserProvider {
  open(url: string, options?: StealthSessionOptions): Promise<StealthExecutionResult>;
  snapshot(options?: StealthSessionOptions): Promise<StealthExecutionResult>;
  title(options?: StealthSessionOptions): Promise<string>;
  executeAction(
    action: BrowserAction,
    options?: StealthSessionOptions,
  ): Promise<StealthExecutionResult>;
  stop(options?: StealthSessionOptions): Promise<void>;
  doctor(options?: StealthSessionOptions): Promise<StealthDoctorResult>;
}
