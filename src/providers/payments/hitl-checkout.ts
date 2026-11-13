import {
  PaymentPolicyError,
  type CheckoutHandoffCard,
  type CheckoutHandoffChannel,
  type CheckoutHandoffPayload,
  type PaymentExecutionResult,
  type PaymentPolicyGuard,
  type PaymentProvider,
  type SpendApproval,
  type SpendIntent,
} from '../../ports/payments.ts';

const FORBIDDEN_CARD_KEYS = new Set([
  'pan',
  'cardnumber',
  'number',
  'cvv',
  'cvc',
  'cvv2',
  'cvc2',
  'securitycode',
  'pin',
  'expiry',
  'expmonth',
  'expyear',
  'track1',
  'track2',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[_-]/g, '');
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function containsRawPanOrCvv(text: string): boolean {
  const candidates = text.match(/(?:\d[\s-]?){13,19}/g);
  if (candidates) {
    for (const candidate of candidates) {
      const digits = candidate.replaceAll(/[\s-]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
        return true;
      }
    }
  }
  return /\b(?:cvv|cvc|security[_-]?code|card[_-]?number|pan)\s*[:=]\s*\d{3,19}\b/i.test(text);
}

function assertNoCardData(input: unknown, depth = 0): void {
  if (depth > 4 || input === null || input === undefined) return;
  if (typeof input === 'string') {
    if (containsRawPanOrCvv(input)) {
      throw new PaymentPolicyError(
        'invalid_intent',
        'Raw card PAN or CVV data must never be included in HITL checkout handoffs.',
      );
    }
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) assertNoCardData(item, depth + 1);
    return;
  }
  if (typeof input === 'object' && !(input instanceof Date)) {
    for (const [key, value] of Object.entries(input)) {
      if (FORBIDDEN_CARD_KEYS.has(normalizeKey(key))) {
        throw new PaymentPolicyError(
          'invalid_intent',
          `Prohibited card data field "${key}" is not allowed in HITL checkout handoffs.`,
        );
      }
      assertNoCardData(value, depth + 1);
    }
  }
}

function validateCheckoutUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new PaymentPolicyError(
      'invalid_intent',
      'checkoutUrl is required to create a HITL checkout handoff.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new PaymentPolicyError('invalid_intent', 'checkoutUrl must be a valid URL.');
  }
  const isLoopbackHttp =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]');
  if (parsed.protocol !== 'https:' && !isLoopbackHttp) {
    throw new PaymentPolicyError(
      'invalid_intent',
      'checkoutUrl must use HTTPS (or loopback HTTP for local testing).',
    );
  }
  if (parsed.username || parsed.password) {
    throw new PaymentPolicyError('invalid_intent', 'checkoutUrl must not embed credentials.');
  }
  for (const param of parsed.searchParams.keys()) {
    if (FORBIDDEN_CARD_KEYS.has(normalizeKey(param))) {
      throw new PaymentPolicyError(
        'invalid_intent',
        `checkoutUrl must not carry sensitive card parameter "${param}".`,
      );
    }
  }
  return parsed.toString();
}

function formatMinorAmount(amountMinor: number, currency: string): string {
  try {
    const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amountMinor / 10 ** digits);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

function normalizeExpiryIso(expiresAt: string | number | Date): string {
  if (expiresAt instanceof Date) return expiresAt.toISOString();
  if (typeof expiresAt === 'number') return new Date(expiresAt).toISOString();
  return new Date(Date.parse(expiresAt)).toISOString();
}

function sanitizeLine(value: string): string {
  return value.replaceAll(/[\r\n\t]+/g, ' ').trim();
}

export interface HitlCheckoutHandoffProvider extends PaymentProvider {
  createCheckoutHandoff(
    intent: SpendIntent,
    approval?: SpendApproval,
  ): Promise<CheckoutHandoffPayload>;
}

export function createHitlCheckoutHandoffProvider(
  guard: PaymentPolicyGuard,
): HitlCheckoutHandoffProvider {
  async function createCheckoutHandoff(
    intent: SpendIntent,
    approval?: SpendApproval,
  ): Promise<CheckoutHandoffPayload> {
    assertNoCardData(intent);
    if (approval !== undefined) assertNoCardData(approval);

    const auth = guard.evaluate(intent, approval, {
      skipHitlCheck: approval === undefined,
    });
    const checkoutUrl = validateCheckoutUrl(intent.checkoutUrl);
    const merchant = sanitizeLine(intent.merchant);
    const description = sanitizeLine(intent.description);
    const formattedAmount = formatMinorAmount(auth.amountMinor, auth.currency);
    const expiresAtIso = normalizeExpiryIso(intent.expiresAt);

    const channels: Record<CheckoutHandoffChannel, CheckoutHandoffCard> = {
      telegram: {
        channel: 'telegram',
        title: `Checkout approval: ${merchant}`,
        body: [
          `Amount: ${formattedAmount} (${auth.currency})`,
          `Merchant: ${merchant} (${auth.merchantOrigin})`,
          `Item: ${description}`,
          `Expires: ${expiresAtIso}`,
          'Complete payment directly in your browser. Never share card numbers or CVV in chat.',
        ].join('\n'),
        actionLabel: 'Open secure checkout',
        actionUrl: checkoutUrl,
      },
      whatsapp: {
        channel: 'whatsapp',
        title: `*Checkout approval: ${merchant}*`,
        body: [
          `*Amount:* ${formattedAmount}`,
          `*Merchant:* ${merchant} (${auth.merchantOrigin})`,
          `*Description:* ${description}`,
          `*Expires:* ${expiresAtIso}`,
          `Checkout link: ${checkoutUrl}`,
          'Complete payment on the merchant page. Never send card details here.',
        ].join('\n'),
        actionLabel: 'Complete checkout',
        actionUrl: checkoutUrl,
      },
      web: {
        channel: 'web',
        title: `Complete checkout with ${merchant}`,
        body: `${formattedAmount} at ${auth.merchantOrigin} — ${description} (expires ${expiresAtIso}). Payment card entry happens only on the merchant checkout page.`,
        actionLabel: 'Continue to checkout',
        actionUrl: checkoutUrl,
      },
    };

    return {
      kind: 'hitl_checkout',
      intentId: auth.intentId,
      merchant,
      merchantOrigin: auth.merchantOrigin,
      amountMinor: auth.amountMinor,
      currency: auth.currency,
      formattedAmount,
      description,
      checkoutUrl,
      expiresAt: expiresAtIso,
      requiresApproval: auth.requiresHitl,
      channels,
      cardDataIncluded: false,
    };
  }

  async function execute(
    intent: SpendIntent,
    approval?: SpendApproval,
  ): Promise<PaymentExecutionResult> {
    const handoff = await createCheckoutHandoff(intent, approval);
    if (approval !== undefined) {
      guard.authorize(intent, approval);
    }
    const spent = guard.dailySpentMinor();
    const remaining = guard.dailyRemainingMinor();
    return {
      status: 'requires_action',
      intentId: handoff.intentId,
      amountMinor: handoff.amountMinor,
      currency: handoff.currency,
      livemode: false,
      ...(approval ? { approvalId: approval.approvalId.trim() } : {}),
      handoff,
      telemetry: {
        provider: 'hitl-checkout',
        livemode: false,
        endpoint: handoff.checkoutUrl,
        requestHeadersRedacted: {},
        recordedSpendMinor: 0,
        dailySpentMinor: spent,
        dailyRemainingMinor: remaining,
      },
    };
  }

  return {
    name: 'hitl-checkout',
    createCheckoutHandoff,
    execute,
  };
}
