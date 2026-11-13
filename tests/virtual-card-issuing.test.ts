import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateLuhnCard,
  createStripeIssuingProvider,
} from '../src/providers/payments/stripe-issuing.ts';
import { createPaymentPolicyGuard } from '../src/providers/payments/guard.ts';
import { PaymentPolicyError } from '../src/ports/payments.ts';

function checkLuhn(cardNumber: string): boolean {
  let sum = 0;
  const len = cardNumber.length;
  for (let i = 0; i < len; i++) {
    let digit = parseInt(cardNumber[len - 1 - i], 10);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

test('generateLuhnCard generates valid 16-digit Luhn card numbers', () => {
  for (let i = 0; i < 10; i++) {
    const card = generateLuhnCard();
    assert.equal(card.length, 16);
    assert.equal(checkLuhn(card), true);
  }
});

test('issueCard enforces PaymentPolicyGuard spend policies before issuing', async () => {
  const guard = createPaymentPolicyGuard({
    maxPerTxMinor: 10_000,
    dailyCapMinor: 20_000,
    allowedCurrencies: ['USD'],
    allowedMerchants: ['https://flights.example.com'],
    requireHitlAboveMinor: 5_000,
  });

  const provider = createStripeIssuingProvider({ guard });

  await assert.rejects(
    async () => {
      await provider.issueCard({
        spendingLimitMinor: 15_000,
        currency: 'USD',
        merchantOrigin: 'https://flights.example.com',
        description: 'Over limit flight ticket',
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof PaymentPolicyError);
      assert.equal(err.code, 'per_tx_limit_exceeded');
      return true;
    },
  );

  await assert.rejects(
    async () => {
      await provider.issueCard({
        spendingLimitMinor: 3_000,
        currency: 'EUR',
        merchantOrigin: 'https://flights.example.com',
        description: 'Disallowed currency',
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof PaymentPolicyError);
      assert.equal(err.code, 'currency_not_allowed');
      return true;
    },
  );

  await assert.rejects(
    async () => {
      await provider.issueCard({
        spendingLimitMinor: 3_000,
        currency: 'USD',
        merchantOrigin: 'https://unauthorized-store.com',
        description: 'Disallowed merchant',
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof PaymentPolicyError);
      assert.equal(err.code, 'merchant_not_allowed');
      return true;
    },
  );

  await assert.rejects(
    async () => {
      await provider.issueCard({
        spendingLimitMinor: 6_000,
        currency: 'USD',
        merchantOrigin: 'https://flights.example.com',
        description: 'Requires approval',
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof PaymentPolicyError);
      assert.equal(err.code, 'hitl_approval_required');
      return true;
    },
  );
});

test('issueCard succeeds with valid policy/approval and produces CardEntry for Computer.fillCard', async () => {
  const guard = createPaymentPolicyGuard({
    maxPerTxMinor: 10_000,
    dailyCapMinor: 20_000,
    allowedCurrencies: ['USD'],
    allowedMerchants: ['https://flights.example.com'],
    requireHitlAboveMinor: 5_000,
  });

  const provider = createStripeIssuingProvider({ guard });

  const card1 = await provider.issueCard({
    spendingLimitMinor: 4_500,
    currency: 'USD',
    merchantOrigin: 'https://flights.example.com',
    description: 'Hotel booking',
  });

  assert.equal(card1.status, 'active');
  assert.equal(card1.spendingLimitMinor, 4_500);
  assert.equal(card1.cardNumber.length, 16);
  assert.equal(checkLuhn(card1.cardNumber), true);
  assert.equal(card1.last4, card1.cardNumber.slice(-4));
  assert.equal(guard.dailySpentMinor(), 4_500);

  const card2 = await provider.issueCard({
    spendingLimitMinor: 8_000,
    currency: 'USD',
    merchantOrigin: 'https://flights.example.com',
    description: 'Roundtrip flight ticket',
    approvalId: 'appr_user_verified_99',
  });

  assert.equal(card2.status, 'active');
  assert.equal(card2.spendingLimitMinor, 8_000);
  assert.equal(guard.dailySpentMinor(), 12_500);

  const cardEntry = provider.toCardEntry(card1, 'thread-session-123');
  assert.equal(cardEntry.threadId, 'thread-session-123');
  assert.equal(cardEntry.card.cardNumber, card1.cardNumber);
  assert.equal(cardEntry.card.securityCode, card1.securityCode);
  assert.equal(cardEntry.card.expiryMonth, card1.expiryMonth);
  assert.equal(cardEntry.card.expiryYear, card1.expiryYear);

  const canceled = await provider.cancelCard(card1.id);
  assert.equal(canceled, true);
  const fetched = await provider.getCard(card1.id);
  assert.equal(fetched?.status, 'canceled');
});
