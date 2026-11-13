import type {
  PaymentExecutionResult,
  PaymentPolicyGuard,
  PaymentProvider,
  SpendApproval,
  SpendIntent,
} from '../../ports/payments.ts';

const STRIPE_PAYMENT_INTENTS_URL = 'https://api.stripe.com/v1/payment_intents';

export interface StripeSandboxProviderOptions {
  apiKey: string;
  stripeAccount?: string;
  livemode?: boolean;
  allowLive?: boolean;
  fetchImpl?: typeof fetch;
  guard: PaymentPolicyGuard;
}

interface StripePaymentIntentResponse {
  id?: unknown;
  status?: unknown;
  amount?: unknown;
  currency?: unknown;
  livemode?: unknown;
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
}

function isLiveStripeKey(apiKey: string): boolean {
  return apiKey.startsWith('sk_live_') || apiKey.startsWith('rk_live_');
}

function redactText(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, '[REDACTED]');
  }
  result = result.replaceAll(/(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g, '[REDACTED]');
  result = result.replaceAll(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  return result;
}

export function createStripeSandboxPaymentProvider(
  options: StripeSandboxProviderOptions,
): PaymentProvider {
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (!apiKey) {
    throw new Error('Stripe API key is required.');
  }
  const livemode = Boolean(options.livemode);
  const allowLive = options.allowLive === true;
  if (livemode && !allowLive) {
    throw new Error('Refusing Stripe livemode execution without explicit allowLive: true.');
  }
  if (isLiveStripeKey(apiKey) && !allowLive) {
    throw new Error('Refusing live Stripe API key without explicit allowLive: true.');
  }
  if (!options.guard) {
    throw new Error('PaymentPolicyGuard is required.');
  }
  const stripeAccount =
    typeof options.stripeAccount === 'string' && options.stripeAccount.trim()
      ? options.stripeAccount.trim()
      : undefined;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const guard = options.guard;
  const secrets = [apiKey, ...(stripeAccount ? [stripeAccount] : [])];

  async function execute(
    intent: SpendIntent,
    approval?: SpendApproval,
  ): Promise<PaymentExecutionResult> {
    if ((livemode || isLiveStripeKey(apiKey)) && !allowLive) {
      throw new Error('Refusing Stripe livemode execution without explicit allowLive: true.');
    }

    const auth = guard.authorize(intent, approval);

    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': auth.intentId,
    };
    if (stripeAccount) {
      headers['stripe-account'] = stripeAccount;
    }

    const requestHeadersRedacted: Record<string, string> = {
      authorization: '[REDACTED]',
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': auth.intentId,
      ...(stripeAccount ? { 'stripe-account': '[REDACTED]' } : {}),
    };

    const body = new URLSearchParams({
      amount: String(auth.amountMinor),
      currency: auth.currency.toLowerCase(),
      description: intent.description.trim(),
      'metadata[intent_id]': auth.intentId,
      'metadata[merchant]': intent.merchant.trim(),
      'metadata[merchant_origin]': auth.merchantOrigin,
      ...(auth.approvalId ? { 'metadata[approval_id]': auth.approvalId } : {}),
    });

    const baseTelemetry = (statusCode?: number, recordedSpendMinor = 0) => ({
      provider: 'stripe-sandbox',
      livemode,
      endpoint: STRIPE_PAYMENT_INTENTS_URL,
      ...(statusCode !== undefined ? { statusCode } : {}),
      requestHeadersRedacted,
      recordedSpendMinor,
      dailySpentMinor: guard.dailySpentMinor(),
      dailyRemainingMinor: guard.dailyRemainingMinor(),
    });

    let response: Response;
    try {
      response = await fetchFn(STRIPE_PAYMENT_INTENTS_URL, {
        method: 'POST',
        headers,
        body: body.toString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        intentId: auth.intentId,
        amountMinor: auth.amountMinor,
        currency: auth.currency,
        livemode,
        ...(auth.approvalId ? { approvalId: auth.approvalId } : {}),
        error: redactText(message, secrets),
        telemetry: baseTelemetry(),
      };
    }

    let payload: StripePaymentIntentResponse | undefined;
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === 'object') {
        payload = parsed as StripePaymentIntentResponse;
      }
    } catch {
      return {
        status: 'failed',
        intentId: auth.intentId,
        amountMinor: auth.amountMinor,
        currency: auth.currency,
        livemode,
        ...(auth.approvalId ? { approvalId: auth.approvalId } : {}),
        error: `Invalid JSON response from Stripe (${response.status}).`,
        telemetry: baseTelemetry(response.status),
      };
    }

    if (payload?.livemode === true && !allowLive) {
      return {
        status: 'failed',
        intentId: auth.intentId,
        amountMinor: auth.amountMinor,
        currency: auth.currency,
        livemode: true,
        ...(auth.approvalId ? { approvalId: auth.approvalId } : {}),
        error: 'Refused livemode Stripe response without explicit allowLive: true.',
        telemetry: {
          ...baseTelemetry(response.status),
          livemode: true,
        },
      };
    }

    if (!response.ok) {
      const rawError =
        typeof payload?.error?.message === 'string'
          ? payload.error.message
          : `Stripe request failed with status ${response.status}.`;
      return {
        status: 'failed',
        intentId: auth.intentId,
        amountMinor: auth.amountMinor,
        currency: auth.currency,
        livemode: Boolean(payload?.livemode ?? livemode),
        ...(auth.approvalId ? { approvalId: auth.approvalId } : {}),
        error: redactText(rawError, secrets),
        telemetry: baseTelemetry(response.status),
      };
    }

    if (
      (typeof payload?.amount === 'number' && payload.amount !== auth.amountMinor) ||
      (typeof payload?.currency === 'string' && payload.currency.toUpperCase() !== auth.currency)
    ) {
      return {
        status: 'failed',
        intentId: auth.intentId,
        providerPaymentId: typeof payload?.id === 'string' ? payload.id : undefined,
        providerStatus: typeof payload?.status === 'string' ? payload.status : undefined,
        amountMinor: auth.amountMinor,
        currency: auth.currency,
        livemode: Boolean(payload?.livemode ?? livemode),
        ...(auth.approvalId ? { approvalId: auth.approvalId } : {}),
        error: 'Stripe response amount or currency did not match SpendIntent.',
        telemetry: baseTelemetry(response.status),
      };
    }

    const providerPaymentId = typeof payload?.id === 'string' ? payload.id : undefined;
    const providerStatus = typeof payload?.status === 'string' ? payload.status : undefined;
    const responseLivemode = Boolean(payload?.livemode ?? livemode);

    if (providerStatus === 'succeeded' && providerPaymentId) {
      guard.recordSpend(intent, approval);
      return {
        status: 'succeeded',
        intentId: auth.intentId,
        providerPaymentId,
        providerStatus,
        amountMinor: auth.amountMinor,
        currency: auth.currency,
        livemode: responseLivemode,
        ...(auth.approvalId ? { approvalId: auth.approvalId } : {}),
        telemetry: {
          ...baseTelemetry(response.status, auth.amountMinor),
          livemode: responseLivemode,
        },
      };
    }

    return {
      status: 'requires_action',
      intentId: auth.intentId,
      ...(providerPaymentId ? { providerPaymentId } : {}),
      ...(providerStatus ? { providerStatus } : {}),
      amountMinor: auth.amountMinor,
      currency: auth.currency,
      livemode: responseLivemode,
      ...(auth.approvalId ? { approvalId: auth.approvalId } : {}),
      telemetry: {
        ...baseTelemetry(response.status, 0),
        livemode: responseLivemode,
      },
    };
  }

  return {
    name: 'stripe-sandbox',
    execute,
  };
}
