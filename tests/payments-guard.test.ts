import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PaymentPolicyError,
  type SpendApproval,
  type SpendIntent,
  type SpendPolicy,
} from '../src/ports/payments.ts';
import { createPaymentPolicyGuard } from '../src/providers/payments/guard.ts';
import { createHitlCheckoutHandoffProvider } from '../src/providers/payments/hitl-checkout.ts';
import { createStripeSandboxPaymentProvider } from '../src/providers/payments/stripe-sandbox.ts';

function makeClock(initialMs = Date.UTC(2026, 10, 11, 12, 0, 0)) {
  let now = initialMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function makePolicy(overrides: Partial<SpendPolicy> = {}): SpendPolicy {
  return {
    maxPerTxMinor: 10_000,
    dailyCapMinor: 25_000,
    allowedCurrencies: ['USD', 'EUR'],
    allowedMerchants: ['https://shop.example.test', 'billing.acme.test'],
    requireHitlAboveMinor: 5_000,
    ...overrides,
  };
}

function makeIntent(nowMs: number, overrides: Partial<SpendIntent> = {}): SpendIntent {
  return {
    intentId: 'intent_001',
    merchant: 'Example Shop',
    merchantOrigin: 'https://shop.example.test',
    amountMinor: 2_500,
    currency: 'USD',
    description: 'Annual developer plan',
    checkoutUrl: 'https://checkout.example.test/session/abc123',
    expiresAt: new Date(nowMs + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

function makeApproval(nowMs: number, overrides: Partial<SpendApproval> = {}): SpendApproval {
  return {
    approvalId: 'appr_001',
    intentId: 'intent_001',
    approvedBy: 'owner@example.test',
    approvedAt: new Date(nowMs).toISOString(),
    singleUse: true,
    ...overrides,
  };
}

test('guard enforces per-transaction limit and basic intent validation', () => {
  const clock = makeClock();
  const guard = createPaymentPolicyGuard(makePolicy({ maxPerTxMinor: 5_000 }), clock.now);

  const ok = guard.evaluate(makeIntent(clock.now(), { amountMinor: 5_000 }));
  assert.equal(ok.amountMinor, 5_000);
  assert.equal(ok.requiresHitl, false);

  assert.throws(
    () => guard.evaluate(makeIntent(clock.now(), { amountMinor: 5_001 })),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'per_tx_limit_exceeded',
  );

  for (const amountMinor of [0, -100, 12.5, Number.NaN]) {
    assert.throws(
      () => guard.evaluate(makeIntent(clock.now(), { amountMinor })),
      (err: unknown) => err instanceof PaymentPolicyError && err.code === 'invalid_intent',
    );
  }
});

test('guard enforces rolling 24h daily spend accumulation and window rolloff', () => {
  const clock = makeClock();
  const guard = createPaymentPolicyGuard(
    makePolicy({ maxPerTxMinor: 15_000, dailyCapMinor: 20_000, requireHitlAboveMinor: 20_000 }),
    clock.now,
  );

  guard.recordSpend(makeIntent(clock.now(), { intentId: 'tx_1', amountMinor: 12_000 }));
  assert.equal(guard.dailySpentMinor(), 12_000);
  assert.equal(guard.dailyRemainingMinor(), 8_000);

  clock.advance(6 * 60 * 60 * 1000);
  guard.recordSpend(makeIntent(clock.now(), { intentId: 'tx_2', amountMinor: 7_000 }));
  assert.equal(guard.dailySpentMinor(), 19_000);
  assert.equal(guard.dailyRemainingMinor(), 1_000);

  assert.throws(
    () => guard.evaluate(makeIntent(clock.now(), { intentId: 'tx_3', amountMinor: 1_001 })),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'daily_cap_exceeded',
  );

  const exactFit = guard.evaluate(makeIntent(clock.now(), { intentId: 'tx_3', amountMinor: 1_000 }));
  assert.equal(exactFit.dailyRemainingMinor, 1_000);

  clock.advance(18 * 60 * 60 * 1000);
  assert.equal(guard.dailySpentMinor(), 7_000);
  assert.equal(guard.dailyRemainingMinor(), 13_000);

  const afterRolloff = guard.evaluate(
    makeIntent(clock.now(), { intentId: 'tx_4', amountMinor: 13_000 }),
  );
  assert.equal(afterRolloff.dailySpentMinor, 7_000);
});

test('guard rejects expired intents', () => {
  const clock = makeClock();
  const guard = createPaymentPolicyGuard(makePolicy(), clock.now);

  assert.throws(
    () =>
      guard.evaluate(
        makeIntent(clock.now(), { expiresAt: new Date(clock.now()).toISOString() }),
      ),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'expired_intent',
  );

  assert.throws(
    () => guard.evaluate(makeIntent(clock.now(), { expiresAt: clock.now() - 1 })),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'expired_intent',
  );
});

test('guard enforces currency allowlist and normalized exact merchant origin/domain allowlist', () => {
  const clock = makeClock();
  const guard = createPaymentPolicyGuard(makePolicy(), clock.now);

  const normalizedUpper = guard.evaluate(
    makeIntent(clock.now(), {
      currency: 'eur',
      merchantOrigin: 'https://SHOP.EXAMPLE.TEST:443/',
    }),
  );
  assert.equal(normalizedUpper.currency, 'EUR');
  assert.equal(normalizedUpper.merchantOrigin, 'https://shop.example.test');

  const normalizedDomain = guard.evaluate(
    makeIntent(clock.now(), {
      merchantOrigin: 'https://billing.acme.test',
    }),
  );
  assert.equal(normalizedDomain.merchantOrigin, 'https://billing.acme.test');

  assert.throws(
    () => guard.evaluate(makeIntent(clock.now(), { currency: 'JPY' })),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'currency_not_allowed',
  );

  for (const merchantOrigin of [
    'http://shop.example.test',
    'http://billing.acme.test',
    'https://sub.shop.example.test',
    'https://sub.billing.acme.test',
    'https://shop.example.test.attacker.invalid',
    'https://shop.example.test:8443',
  ]) {
    assert.throws(
      () => guard.evaluate(makeIntent(clock.now(), { merchantOrigin })),
      (err: unknown) => err instanceof PaymentPolicyError && err.code === 'merchant_not_allowed',
    );
  }

  for (const merchantOrigin of [
    'https://shop.example.test/checkout',
    'https://user:pass@shop.example.test',
    'https://shop.example.test?foo=bar',
    'shop.example.test',
  ]) {
    assert.throws(
      () => guard.evaluate(makeIntent(clock.now(), { merchantOrigin })),
      (err: unknown) => err instanceof PaymentPolicyError && err.code === 'invalid_intent',
    );
  }
});

test('guard enforces HITL approval requirement and single-use approvalId replay protection', () => {
  const clock = makeClock();
  const guard = createPaymentPolicyGuard(makePolicy(), clock.now);
  const highIntent = makeIntent(clock.now(), { intentId: 'intent_high', amountMinor: 8_000 });

  assert.throws(
    () => guard.authorize(highIntent),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'hitl_approval_required',
  );

  assert.throws(
    () =>
      guard.authorize(
        highIntent,
        makeApproval(clock.now(), { intentId: 'other_intent', approvalId: 'appr_bad_1' }),
      ),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'invalid_approval',
  );

  assert.throws(
    () =>
      guard.authorize(
        highIntent,
        makeApproval(clock.now(), { intentId: 'intent_high', singleUse: false }),
      ),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'invalid_approval',
  );

  const approval = makeApproval(clock.now(), {
    approvalId: 'appr_single_1',
    intentId: 'intent_high',
  });
  const auth = guard.authorize(highIntent, approval);
  assert.equal(auth.requiresHitl, true);
  assert.equal(auth.approvalId, 'appr_single_1');

  assert.throws(
    () => guard.authorize(highIntent, approval),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'approval_replay',
  );

  guard.recordSpend(highIntent, approval);
  assert.equal(guard.dailySpentMinor(), 8_000);

  assert.throws(
    () => guard.recordSpend(highIntent, approval),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'approval_replay',
  );

  const secondIntent = makeIntent(clock.now(), { intentId: 'intent_high_2', amountMinor: 7_500 });
  assert.throws(
    () =>
      guard.authorize(
        secondIntent,
        makeApproval(clock.now(), { approvalId: 'appr_single_1', intentId: 'intent_high_2' }),
      ),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'approval_replay',
  );
});

test('hitl checkout handoff generates channel cards without touching raw PAN/CVV numbers', async () => {
  const clock = makeClock();
  const guard = createPaymentPolicyGuard(makePolicy(), clock.now);
  const handoffProvider = createHitlCheckoutHandoffProvider(guard);

  const highIntent = makeIntent(clock.now(), {
    intentId: 'intent_hitl_1',
    amountMinor: 9_000,
    currency: 'USD',
    checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
  });

  const payload = await handoffProvider.createCheckoutHandoff(highIntent);
  assert.equal(payload.kind, 'hitl_checkout');
  assert.equal(payload.cardDataIncluded, false);
  assert.equal(payload.requiresApproval, true);
  assert.equal(payload.formattedAmount, '$90.00');
  assert.equal(payload.channels.telegram.channel, 'telegram');
  assert.equal(payload.channels.whatsapp.channel, 'whatsapp');
  assert.equal(payload.channels.web.channel, 'web');
  assert.equal(
    payload.channels.telegram.actionUrl,
    'https://checkout.stripe.com/c/pay/cs_test_123',
  );
  assert.match(payload.channels.whatsapp.body, /https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_123/);
  assert.equal(guard.dailySpentMinor(), 0);

  const execResult = await handoffProvider.execute(highIntent);
  assert.equal(execResult.status, 'requires_action');
  assert.equal(execResult.telemetry.recordedSpendMinor, 0);
  assert.ok(execResult.handoff);
  assert.equal(guard.dailySpentMinor(), 0);

  await assert.rejects(
    () =>
      handoffProvider.createCheckoutHandoff(
        makeIntent(clock.now(), {
          description: 'Card 4242 4242 4242 4242',
        }),
      ),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'invalid_intent',
  );

  await assert.rejects(
    () =>
      handoffProvider.createCheckoutHandoff({
        ...makeIntent(clock.now()),
        cvv: '737',
      } as SpendIntent),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'invalid_intent',
  );

  await assert.rejects(
    () =>
      handoffProvider.createCheckoutHandoff(
        makeIntent(clock.now(), { checkoutUrl: 'javascript:alert(1)' }),
      ),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'invalid_intent',
  );

  await assert.rejects(
    () =>
      handoffProvider.createCheckoutHandoff(
        makeIntent(clock.now(), { merchantOrigin: 'https://unlisted.example.test' }),
      ),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'merchant_not_allowed',
  );
});

test('stripe sandbox refuses livemode unless allowLive: true is explicitly passed', () => {
  const clock = makeClock();
  const guard = createPaymentPolicyGuard(makePolicy(), clock.now);

  assert.throws(
    () =>
      createStripeSandboxPaymentProvider({
        apiKey: 'sk_test_sandbox_mock_001',
        livemode: true,
        guard,
      }),
    /livemode/i,
  );

  assert.throws(
    () =>
      createStripeSandboxPaymentProvider({
        apiKey: 'stripe_mock_key_001',
        livemode: false,
        guard,
      }),
    /live/i,
  );

  const explicitLive = createStripeSandboxPaymentProvider({
    apiKey: 'stripe_mock_key_001',
    livemode: true,
    allowLive: true,
    guard,
  });
  assert.equal(explicitLive.name, 'stripe-sandbox');
});

test('stripe sandbox executes PaymentIntent via fetchImpl, records spend only on success, and redacts secrets', async () => {
  const clock = makeClock();
  const guard = createPaymentPolicyGuard(makePolicy(), clock.now);
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];

  let nextResponse: { status: number; body: unknown } = {
    status: 200,
    body: {
      id: 'pi_test_001',
      status: 'succeeded',
      amount: 7_500,
      currency: 'usd',
      livemode: false,
    },
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: String(init?.body ?? ''),
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  const secretKey = 'sk_test_sandbox_secret_999';
  const connectAccount = 'acct_sandbox_123';
  const provider = createStripeSandboxPaymentProvider({
    apiKey: secretKey,
    stripeAccount: connectAccount,
    livemode: false,
    fetchImpl,
    guard,
  });

  const intent = makeIntent(clock.now(), {
    intentId: 'intent_stripe_1',
    amountMinor: 7_500,
    currency: 'USD',
  });
  const approval = makeApproval(clock.now(), {
    approvalId: 'appr_stripe_1',
    intentId: 'intent_stripe_1',
  });

  const result = await provider.execute(intent, approval);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.providerPaymentId, 'pi_test_001');
  assert.equal(result.telemetry.recordedSpendMinor, 7_500);
  assert.equal(result.telemetry.dailySpentMinor, 7_500);
  assert.equal(result.telemetry.dailyRemainingMinor, 17_500);
  assert.equal(result.telemetry.requestHeadersRedacted.authorization, '[REDACTED]');
  assert.equal(result.telemetry.requestHeadersRedacted['stripe-account'], '[REDACTED]');
  assert.equal(JSON.stringify(result).includes(secretKey), false);
  assert.equal(JSON.stringify(result).includes(connectAccount), false);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, 'https://api.stripe.com/v1/payment_intents');
  assert.equal(requests[0]!.method, 'POST');
  assert.equal(requests[0]!.headers.authorization, `Bearer ${secretKey}`);
  assert.equal(requests[0]!.headers['stripe-account'], connectAccount);
  const sentParams = new URLSearchParams(requests[0]!.body);
  assert.equal(sentParams.get('amount'), '7500');
  assert.equal(sentParams.get('currency'), 'usd');
  assert.equal(sentParams.get('metadata[intent_id]'), 'intent_stripe_1');

  await assert.rejects(
    () => provider.execute(intent, approval),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'approval_replay',
  );
  assert.equal(requests.length, 1);

  nextResponse = {
    status: 200,
    body: {
      id: 'pi_test_pending',
      status: 'requires_action',
      amount: 2_000,
      currency: 'usd',
      livemode: false,
    },
  };
  const pendingResult = await provider.execute(
    makeIntent(clock.now(), { intentId: 'intent_pending', amountMinor: 2_000 }),
  );
  assert.equal(pendingResult.status, 'requires_action');
  assert.equal(pendingResult.telemetry.recordedSpendMinor, 0);
  assert.equal(guard.dailySpentMinor(), 7_500);

  nextResponse = {
    status: 402,
    body: {
      error: {
        message: `Card declined for key ${secretKey} on ${connectAccount}`,
      },
    },
  };
  const failedResult = await provider.execute(
    makeIntent(clock.now(), { intentId: 'intent_failed', amountMinor: 2_000 }),
  );
  assert.equal(failedResult.status, 'failed');
  assert.equal(failedResult.telemetry.recordedSpendMinor, 0);
  assert.equal(failedResult.error?.includes(secretKey), false);
  assert.equal(failedResult.error?.includes(connectAccount), false);
  assert.equal(guard.dailySpentMinor(), 7_500);

  await assert.rejects(
    () =>
      provider.execute(
        makeIntent(clock.now(), {
          intentId: 'intent_over_cap',
          amountMinor: 10_001,
        }),
      ),
    (err: unknown) => err instanceof PaymentPolicyError && err.code === 'per_tx_limit_exceeded',
  );
  assert.equal(requests.length, 3);
});
