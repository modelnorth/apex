import {
  PaymentPolicyError,
  type PaymentAuthorization,
  type PaymentPolicyEvaluateOptions,
  type PaymentPolicyGuard,
  type SpendApproval,
  type SpendIntent,
  type SpendLedgerEntry,
  type SpendPolicy,
} from '../../ports/payments.ts';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : Number.NaN;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return Number.NaN;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : Number.NaN;
  }
  return Number.NaN;
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(trimmed)) return null;
  return trimmed;
}

export function normalizeMerchantOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed) || !trimmed.includes('://')) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.origin === 'null') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== '/') return null;
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  const schemeEnd = withoutTrailingSlash.indexOf('://') + 3;
  if (withoutTrailingSlash.indexOf('/', schemeEnd) !== -1) return null;
  return parsed.origin;
}

function normalizeAllowedMerchant(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (trimmed.includes('://')) return normalizeMerchantOrigin(trimmed);
  if (/[/?#@*]/.test(trimmed)) return null;
  return normalizeMerchantOrigin(`https://${trimmed}`);
}

function validatePolicy(policy: SpendPolicy): {
  normalizedPolicy: SpendPolicy;
  allowedCurrencies: Set<string>;
  allowedMerchants: Set<string>;
} {
  if (!policy || typeof policy !== 'object') {
    throw new PaymentPolicyError('invalid_policy', 'SpendPolicy must be an object.');
  }
  for (const [name, value] of [
    ['maxPerTxMinor', policy.maxPerTxMinor],
    ['dailyCapMinor', policy.dailyCapMinor],
    ['requireHitlAboveMinor', policy.requireHitlAboveMinor],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PaymentPolicyError('invalid_policy', `${name} must be a non-negative integer.`);
    }
  }
  if (!Array.isArray(policy.allowedCurrencies) || !Array.isArray(policy.allowedMerchants)) {
    throw new PaymentPolicyError(
      'invalid_policy',
      'allowedCurrencies and allowedMerchants must be arrays.',
    );
  }
  const allowedCurrencies = new Set<string>();
  for (const entry of policy.allowedCurrencies) {
    const normalized = normalizeCurrency(entry);
    if (!normalized) {
      throw new PaymentPolicyError('invalid_policy', `Invalid currency in policy: ${String(entry)}`);
    }
    allowedCurrencies.add(normalized);
  }
  const allowedMerchants = new Set<string>();
  for (const entry of policy.allowedMerchants) {
    const normalized = normalizeAllowedMerchant(entry);
    if (!normalized) {
      throw new PaymentPolicyError('invalid_policy', `Invalid merchant in policy: ${String(entry)}`);
    }
    allowedMerchants.add(normalized);
  }
  return {
    normalizedPolicy: {
      maxPerTxMinor: policy.maxPerTxMinor,
      dailyCapMinor: policy.dailyCapMinor,
      allowedCurrencies: [...allowedCurrencies],
      allowedMerchants: [...allowedMerchants],
      requireHitlAboveMinor: policy.requireHitlAboveMinor,
    },
    allowedCurrencies,
    allowedMerchants,
  };
}

function validateIntentBasics(intent: SpendIntent): {
  intentId: string;
  merchant: string;
  merchantOrigin: string;
  amountMinor: number;
  currency: string;
  expiresAtMs: number;
} {
  if (!intent || typeof intent !== 'object') {
    throw new PaymentPolicyError('invalid_intent', 'SpendIntent must be an object.');
  }
  if (typeof intent.intentId !== 'string' || !intent.intentId.trim()) {
    throw new PaymentPolicyError('invalid_intent', 'intentId must be a non-empty string.');
  }
  if (typeof intent.merchant !== 'string' || !intent.merchant.trim()) {
    throw new PaymentPolicyError('invalid_intent', 'merchant must be a non-empty string.');
  }
  const merchantOrigin = normalizeMerchantOrigin(intent.merchantOrigin);
  if (!merchantOrigin) {
    throw new PaymentPolicyError(
      'invalid_intent',
      'merchantOrigin must be a valid HTTP/HTTPS origin without path, query, fragment, or credentials.',
    );
  }
  if (!Number.isSafeInteger(intent.amountMinor) || intent.amountMinor <= 0) {
    throw new PaymentPolicyError(
      'invalid_intent',
      'amountMinor must be a positive safe integer in minor currency units.',
    );
  }
  const currency = normalizeCurrency(intent.currency);
  if (!currency) {
    throw new PaymentPolicyError('invalid_intent', 'currency must be a 3-letter ISO currency code.');
  }
  if (typeof intent.description !== 'string' || !intent.description.trim()) {
    throw new PaymentPolicyError('invalid_intent', 'description must be a non-empty string.');
  }
  const expiresAtMs = parseTimestamp(intent.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new PaymentPolicyError('invalid_intent', 'expiresAt must be a valid timestamp.');
  }
  return {
    intentId: intent.intentId.trim(),
    merchant: intent.merchant.trim(),
    merchantOrigin,
    amountMinor: intent.amountMinor,
    currency,
    expiresAtMs,
  };
}

function validateApprovalShape(approval: SpendApproval, expectedIntentId: string): string {
  if (!approval || typeof approval !== 'object') {
    throw new PaymentPolicyError('invalid_approval', 'SpendApproval must be an object.');
  }
  if (typeof approval.approvalId !== 'string' || !approval.approvalId.trim()) {
    throw new PaymentPolicyError('invalid_approval', 'approvalId must be a non-empty string.');
  }
  if (typeof approval.intentId !== 'string' || approval.intentId.trim() !== expectedIntentId) {
    throw new PaymentPolicyError('invalid_approval', 'Approval intentId does not match SpendIntent.');
  }
  if (typeof approval.approvedBy !== 'string' || !approval.approvedBy.trim()) {
    throw new PaymentPolicyError('invalid_approval', 'approvedBy must be a non-empty string.');
  }
  if (!Number.isFinite(parseTimestamp(approval.approvedAt))) {
    throw new PaymentPolicyError('invalid_approval', 'approvedAt must be a valid timestamp.');
  }
  if (approval.singleUse !== true) {
    throw new PaymentPolicyError('invalid_approval', 'SpendApproval must enforce singleUse: true.');
  }
  return approval.approvalId.trim();
}

export function createPaymentPolicyGuard(
  policy: SpendPolicy,
  clock: () => number = () => Date.now(),
): PaymentPolicyGuard {
  const { normalizedPolicy, allowedCurrencies, allowedMerchants } = validatePolicy(policy);
  const spendLedger: SpendLedgerEntry[] = [];
  const usedApprovals = new Map<string, { intentId: string; recorded: boolean }>();

  function pruneAndSum(nowMs: number): number {
    let total = 0;
    let writeIndex = 0;
    for (let i = 0; i < spendLedger.length; i += 1) {
      const entry = spendLedger[i]!;
      const ageMs = nowMs - entry.recordedAt;
      if (ageMs < ONE_DAY_MS) {
        spendLedger[writeIndex] = entry;
        writeIndex += 1;
        total += entry.amountMinor;
      }
    }
    spendLedger.length = writeIndex;
    return total;
  }

  function evaluate(
    intent: SpendIntent,
    approval?: SpendApproval,
    options?: PaymentPolicyEvaluateOptions,
  ): PaymentAuthorization {
    const nowMs = clock();
    const parsed = validateIntentBasics(intent);

    if (parsed.expiresAtMs <= nowMs) {
      throw new PaymentPolicyError('expired_intent', `SpendIntent ${parsed.intentId} has expired.`);
    }
    if (!allowedCurrencies.has(parsed.currency)) {
      throw new PaymentPolicyError(
        'currency_not_allowed',
        `Currency ${parsed.currency} is not in allowedCurrencies.`,
      );
    }
    if (!allowedMerchants.has(parsed.merchantOrigin)) {
      throw new PaymentPolicyError(
        'merchant_not_allowed',
        `Merchant origin ${parsed.merchantOrigin} is not in allowedMerchants.`,
      );
    }
    if (parsed.amountMinor > normalizedPolicy.maxPerTxMinor) {
      throw new PaymentPolicyError(
        'per_tx_limit_exceeded',
        `Amount ${parsed.amountMinor} exceeds maxPerTxMinor (${normalizedPolicy.maxPerTxMinor}).`,
      );
    }

    const dailySpent = pruneAndSum(nowMs);
    if (dailySpent + parsed.amountMinor > normalizedPolicy.dailyCapMinor) {
      throw new PaymentPolicyError(
        'daily_cap_exceeded',
        `Spend of ${parsed.amountMinor} plus 24h total ${dailySpent} exceeds dailyCapMinor (${normalizedPolicy.dailyCapMinor}).`,
      );
    }

    const requiresHitl = parsed.amountMinor > normalizedPolicy.requireHitlAboveMinor;
    let approvalId: string | undefined;

    if (approval !== undefined) {
      approvalId = validateApprovalShape(approval, parsed.intentId);
      if (usedApprovals.has(approvalId)) {
        throw new PaymentPolicyError(
          'approval_replay',
          `Approval ${approvalId} has already been used.`,
        );
      }
    } else if (requiresHitl && !options?.skipHitlCheck) {
      throw new PaymentPolicyError(
        'hitl_approval_required',
        `Amount ${parsed.amountMinor} exceeds requireHitlAboveMinor (${normalizedPolicy.requireHitlAboveMinor}) and requires HITL approval.`,
      );
    }

    return {
      intentId: parsed.intentId,
      merchantOrigin: parsed.merchantOrigin,
      amountMinor: parsed.amountMinor,
      currency: parsed.currency,
      requiresHitl,
      approvalId,
      dailySpentMinor: dailySpent,
      dailyRemainingMinor: Math.max(0, normalizedPolicy.dailyCapMinor - dailySpent),
    };
  }

  function authorize(intent: SpendIntent, approval?: SpendApproval): PaymentAuthorization {
    const auth = evaluate(intent, approval);
    if (auth.approvalId) {
      usedApprovals.set(auth.approvalId, { intentId: auth.intentId, recorded: false });
    }
    return auth;
  }

  function recordSpend(intent: SpendIntent, approval?: SpendApproval): SpendLedgerEntry {
    const nowMs = clock();
    const parsed = validateIntentBasics(intent);
    if (!allowedCurrencies.has(parsed.currency)) {
      throw new PaymentPolicyError(
        'currency_not_allowed',
        `Currency ${parsed.currency} is not in allowedCurrencies.`,
      );
    }
    if (!allowedMerchants.has(parsed.merchantOrigin)) {
      throw new PaymentPolicyError(
        'merchant_not_allowed',
        `Merchant origin ${parsed.merchantOrigin} is not in allowedMerchants.`,
      );
    }
    let approvalId: string | undefined;
    if (approval !== undefined) {
      approvalId = validateApprovalShape(approval, parsed.intentId);
      const existing = usedApprovals.get(approvalId);
      if (existing) {
        if (existing.intentId !== parsed.intentId || existing.recorded) {
          throw new PaymentPolicyError(
            'approval_replay',
            `Approval ${approvalId} has already been used.`,
          );
        }
        existing.recorded = true;
      } else {
        usedApprovals.set(approvalId, { intentId: parsed.intentId, recorded: true });
      }
    }
    pruneAndSum(nowMs);
    const entry: SpendLedgerEntry = {
      intentId: parsed.intentId,
      merchantOrigin: parsed.merchantOrigin,
      amountMinor: parsed.amountMinor,
      currency: parsed.currency,
      recordedAt: nowMs,
      ...(approvalId ? { approvalId } : {}),
    };
    spendLedger.push(entry);
    return { ...entry };
  }

  function dailySpentMinor(): number {
    return pruneAndSum(clock());
  }

  function dailyRemainingMinor(): number {
    return Math.max(0, normalizedPolicy.dailyCapMinor - dailySpentMinor());
  }

  function ledger(): SpendLedgerEntry[] {
    pruneAndSum(clock());
    return spendLedger.map((entry) => ({ ...entry }));
  }

  return {
    policy: normalizedPolicy,
    evaluate,
    authorize,
    recordSpend,
    dailySpentMinor,
    dailyRemainingMinor,
    ledger,
  };
}
