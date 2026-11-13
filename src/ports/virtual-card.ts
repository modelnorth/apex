import type { CardEntry } from './computer.ts';

export interface VirtualCard {
  id: string;
  cardNumber: string;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  securityCode: string;
  cardholder: string;
  brand: 'visa' | 'mastercard';
  spendingLimitMinor: number;
  currency: string;
  merchantOrigin?: string;
  status: 'active' | 'canceled';
  expiresAt: string;
}

export interface IssueVirtualCardRequest {
  spendingLimitMinor: number;
  currency: string;
  merchantOrigin: string;
  description: string;
  cardholderName?: string;
  approvalId?: string;
}

export interface VirtualCardPort {
  issueCard(request: IssueVirtualCardRequest): Promise<VirtualCard>;
  cancelCard(cardId: string): Promise<boolean>;
  getCard(cardId: string): Promise<VirtualCard | null>;
  toCardEntry(card: VirtualCard, threadId: string): CardEntry;
}
