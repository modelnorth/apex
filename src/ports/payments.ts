export interface SpendPolicy {
  maxPerTxMinor: number;
  dailyCapMinor: number;
  allowedCurrencies: string[];
  allowedMerchants: string[];
  requireHitlAboveMinor: number;
}

export interface SpendIntent {
  intentId: string;
  merchant: string;
  merchantOrigin: string;
  amountMinor: number;
  currency: string;
  description: string;
  checkoutUrl?: string;
  expiresAt: string | number | Date;
}

export interface SpendApproval {
  approvalId: string;
  intentId: string;
  approvedBy: string;
  approvedAt: string | number | Date;
  singleUse: boolean;
}

export type CheckoutHandoffChannel = 'telegram' | 'whatsapp' | 'web';

export interface CheckoutHandoffCard {
  channel: CheckoutHandoffChannel;
  title: string;
  body: string;
  actionLabel: string;
  actionUrl: string;
}

export interface CheckoutHandoffPayload {
  kind: 'hitl_checkout';
  intentId: string;
  merchant: string;
  merchantOrigin: string;
  amountMinor: number;
  currency: string;
  formattedAmount: string;
  description: string;
  checkoutUrl: string;
  expiresAt: string;
  requiresApproval: boolean;
  channels: Record<CheckoutHandoffChannel, CheckoutHandoffCard>;
  cardDataIncluded: false;
}

export interface PaymentExecutionTelemetry {
  provider: string;
  livemode: boolean;
  endpoint: string;
  statusCode?: number;
  requestHeadersRedacted: Record<string, string>;
  recordedSpendMinor: number;
  dailySpentMinor: number;
  dailyRemainingMinor: number;
}

export interface PaymentExecutionResult {
  status: 'succeeded' | 'requires_action' | 'failed';
  intentId: string;
  providerPaymentId?: string;
  providerStatus?: string;
  amountMinor: number;
  currency: string;
  livemode: boolean;
  approvalId?: string;
  error?: string;
  handoff?: CheckoutHandoffPayload;
  telemetry: PaymentExecutionTelemetry;
}

export type PaymentPolicyViolationCode =
  | 'invalid_policy'
  | 'invalid_intent'
  | 'expired_intent'
  | 'currency_not_allowed'
  | 'merchant_not_allowed'
  | 'per_tx_limit_exceeded'
  | 'daily_cap_exceeded'
  | 'hitl_approval_required'
  | 'invalid_approval'
  | 'approval_replay';

export class PaymentPolicyError extends Error {
  constructor(
    readonly code: PaymentPolicyViolationCode,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentPolicyError';
  }
}

export interface SpendLedgerEntry {
  intentId: string;
  merchantOrigin: string;
  amountMinor: number;
  currency: string;
  recordedAt: number;
  approvalId?: string;
}

export interface PaymentAuthorization {
  intentId: string;
  merchantOrigin: string;
  amountMinor: number;
  currency: string;
  requiresHitl: boolean;
  approvalId?: string;
  dailySpentMinor: number;
  dailyRemainingMinor: number;
}

export interface PaymentPolicyEvaluateOptions {
  skipHitlCheck?: boolean;
}

export interface PaymentPolicyGuard {
  readonly policy: SpendPolicy;
  evaluate(
    intent: SpendIntent,
    approval?: SpendApproval,
    options?: PaymentPolicyEvaluateOptions,
  ): PaymentAuthorization;
  authorize(intent: SpendIntent, approval?: SpendApproval): PaymentAuthorization;
  recordSpend(intent: SpendIntent, approval?: SpendApproval): SpendLedgerEntry;
  dailySpentMinor(): number;
  dailyRemainingMinor(): number;
  ledger(): SpendLedgerEntry[];
}

export interface PaymentProvider {
  readonly name: string;
  execute(intent: SpendIntent, approval?: SpendApproval): Promise<PaymentExecutionResult>;
  createCheckoutHandoff?(
    intent: SpendIntent,
    approval?: SpendApproval,
  ): Promise<CheckoutHandoffPayload>;
}
