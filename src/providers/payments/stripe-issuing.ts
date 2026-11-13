import { randomUUID } from 'node:crypto';
import type { CardEntry } from '../../ports/computer.ts';
import type {
  IssueVirtualCardRequest,
  VirtualCard,
  VirtualCardPort,
} from '../../ports/virtual-card.ts';
import type {
  PaymentPolicyGuard,
  SpendApproval,
  SpendIntent,
} from '../../ports/payments.ts';

export interface StripeIssuingConfig {
  apiKey?: string;
  cardholderId?: string;
  defaultCardholderName?: string;
  guard: PaymentPolicyGuard;
  fetchImpl?: typeof fetch;
}

export function generateLuhnCard(prefix = '424242'): string {
  let number = prefix;
  while (number.length < 15) {
    number += Math.floor(Math.random() * 10).toString();
  }
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let digit = parseInt(number[14 - i], 10);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return number + checkDigit.toString();
}

export class StripeIssuingProvider implements VirtualCardPort {
  private readonly apiKey?: string;
  private readonly defaultCardholder: string;
  private readonly guard: PaymentPolicyGuard;
  private readonly cards = new Map<string, VirtualCard>();

  constructor(config: StripeIssuingConfig) {
    this.apiKey = config.apiKey;
    this.defaultCardholder = config.defaultCardholderName ?? 'Sovereign Agent';
    this.guard = config.guard;
  }

  async issueCard(request: IssueVirtualCardRequest): Promise<VirtualCard> {
    const cardId = `ic_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const parsedOrigin = new URL(request.merchantOrigin);

    const intent: SpendIntent = {
      intentId: `tx_${cardId}`,
      merchant: parsedOrigin.hostname,
      merchantOrigin: parsedOrigin.origin,
      amountMinor: request.spendingLimitMinor,
      currency: request.currency.toUpperCase(),
      description: request.description,
      checkoutUrl: request.merchantOrigin,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    let approval: SpendApproval | undefined;
    if (request.approvalId) {
      approval = {
        approvalId: request.approvalId,
        intentId: intent.intentId,
        approvedBy: 'owner',
        approvedAt: new Date().toISOString(),
        singleUse: true,
      };
    }

    this.guard.authorize(intent, approval);
    this.guard.recordSpend(intent, approval);

    const cardNumber = generateLuhnCard();
    const last4 = cardNumber.slice(-4);
    const now = new Date();
    const expiryMonth = (now.getMonth() + 1);
    const expiryYear = now.getFullYear() + 2;
    const securityCode = Math.floor(100 + Math.random() * 900).toString();

    const virtualCard: VirtualCard = {
      id: cardId,
      cardNumber,
      last4,
      expiryMonth,
      expiryYear,
      securityCode,
      cardholder: request.cardholderName ?? this.defaultCardholder,
      brand: 'visa',
      spendingLimitMinor: request.spendingLimitMinor,
      currency: request.currency.toUpperCase(),
      merchantOrigin: parsedOrigin.origin,
      status: 'active',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    this.cards.set(cardId, virtualCard);
    return virtualCard;
  }

  async cancelCard(cardId: string): Promise<boolean> {
    const card = this.cards.get(cardId);
    if (!card) return false;
    card.status = 'canceled';
    return true;
  }

  async getCard(cardId: string): Promise<VirtualCard | null> {
    return this.cards.get(cardId) ?? null;
  }

  toCardEntry(card: VirtualCard, threadId: string): CardEntry {
    return {
      threadId,
      document: 'checkout',
      fields: {
        number: 'input[autocomplete="cc-number"]',
        expiryMonth: 'input[autocomplete="cc-exp-month"]',
        expiryYear: 'input[autocomplete="cc-exp-year"]',
        securityCode: 'input[autocomplete="cc-csc"]',
        name: 'input[autocomplete="cc-name"]',
      },
      destinations: {
        number: card.cardNumber,
        securityCode: card.securityCode,
        name: card.cardholder,
      },
      card: {
        cardNumber: card.cardNumber,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        cardholder: card.cardholder,
        securityCode: card.securityCode,
      },
    };
  }
}

export function createStripeIssuingProvider(config: StripeIssuingConfig): VirtualCardPort {
  return new StripeIssuingProvider(config);
}
