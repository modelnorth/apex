import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nodTools } from '../src/runtime/tools.ts';
import type { Turn } from '../src/runtime/turn.ts';
import type { RuntimeContext } from '../src/ports/agent.ts';
import { fakeComputer, fakeExecution } from './runtime-fixtures.ts';
import type { StealthBrowserProvider } from '../src/ports/stealth-browser.ts';
import type { DesktopPort } from '../src/ports/desktop.ts';
import type { PhoneCallProvider } from '../src/ports/phone-call.ts';
import type { PaymentPolicyGuard, PaymentProvider } from '../src/ports/payments.ts';
import type { TrustedA2APort } from '../src/ports/a2a.ts';
import { generateA2AKeyPair, createTrustedA2AProtocol } from '../src/providers/a2a/protocol.ts';
import { createPaymentPolicyGuard } from '../src/providers/payments/guard.ts';
import { createHitlCheckoutHandoffProvider } from '../src/providers/payments/hitl-checkout.ts';
import { createStripeIssuingProvider } from '../src/providers/payments/stripe-issuing.ts';
import { createInboundPhoneService } from '../src/providers/twilio/inbound.ts';

function createMockTurn(contextOverrides: Partial<RuntimeContext> = {}): Turn {
  const turnId = randomUUID();
  const context: RuntimeContext = {
    threadId: 'thread-test-1',
    turnId,
    sessionId: 'session-test-1',
    prompt: 'test prompt',
    workspacePath: '/test/workspace',
    history: [],
    attachments: [],
    signal: new AbortController().signal,
    emit: async () => {},
    reply: async () => {},
    delta: () => {},
    publish: async () => ({
      id: 'art-1',
      name: 'test.txt',
      size: 10,
      url: 'file:///test',
      mimeType: 'text/plain',
      source: 'browser_screenshot',
    }),
    requestCredential: async () => ({ filled: true }),
    integration: async () => ({}),
    manage: async () => ({}),
    ...contextOverrides,
  };

  return {
    context,
    computer: fakeComputer(),
    execution: fakeExecution('thread-test-1', turnId),
    reply: async () => ({ delivered: true, presentation: 'original' }),
    pause: async () => {},
    confirm: async (result) => result,
    visited: () => {},
  };
}

test('nodTools does not expose sovereign tools when context.sovereign is undefined', () => {
  const turn = createMockTurn();
  const tools = nodTools(turn);
  const toolNames = tools.map((t) => t.name);

  assert.equal(toolNames.includes('stealth_browse'), false);
  assert.equal(toolNames.includes('desktop_control'), false);
  assert.equal(toolNames.includes('concierge_call'), false);
  assert.equal(toolNames.includes('checkout_payment'), false);
  assert.equal(toolNames.includes('a2a_coordinate'), false);
});

test('nodTools exposes and executes sovereign tools when context.sovereign is configured', async () => {
  const fakeStealth: StealthBrowserProvider = {
    open: async (url, opts) => ({
      observation: { text: `Opened ${url}`, url },
      title: 'Mock Page',
      mode: opts?.mode ?? 'local',
      session: opts?.session ?? 'default',
      challenge: 'none',
      escalateToRemote: false,
      rawOutput: 'ok',
    }),
    snapshot: async () => ({
      observation: { text: 'Snapshot body', url: 'https://example.com' },
      mode: 'local',
      session: 'default',
      challenge: 'none',
      escalateToRemote: false,
      rawOutput: 'ok',
    }),
    title: async () => 'Mock Page Title',
    executeAction: async (action) => ({
      observation: { text: `Executed ${action.action}`, url: 'https://example.com' },
      mode: 'local',
      session: 'default',
      challenge: 'none',
      escalateToRemote: false,
      rawOutput: 'ok',
    }),
    stop: async () => {},
    doctor: async () => ({ ok: true, mode: 'local', output: 'ok', remoteAvailable: false }),
  };

  const fakeDesktop: DesktopPort = {
    status: async () => ({
      ok: true,
      platform: 'windows',
      accessibility: 'granted',
      interactiveSession: true,
    }),
    listApps: async () => [{ name: 'TestApp', pid: 1234 }],
    listWindows: async () => [{ id: 'w1', title: 'Test Window', app: 'TestApp' }],
    snapshot: async () => ({
      ok: true,
      snapshotId: 's1',
      tree: { ref: '@s1:e1', role: 'window', name: 'Main' },
    }),
    click: async (ref) => ({ ok: true, action: 'click', targetRef: ref }),
    type: async (ref) => ({ ok: true, action: 'type', targetRef: ref }),
    press: async (key) => ({ ok: true, action: 'press', targetRef: key }),
    focusWindow: async (target) => ({ ok: true, action: 'focus-window', targetRef: target }),
    launch: async (app) => ({ ok: true, action: 'launch', targetRef: app }),
  };

  const fakePhone: PhoneCallProvider = {
    id: 'mock-twilio',
    configured: true,
    placeCall: async (req) => ({
      callSid: 'CA_mock_1',
      status: 'queued',
      to: req.to,
      from: '+15550000000',
      approvalId: req.approvalId ?? 'appr_1',
    }),
    verifyWebhookSignature: () => true,
    buildTwiml: () => '<Response />',
    handleRelayMessage: async () => null,
  };

  const paymentGuard: PaymentPolicyGuard = createPaymentPolicyGuard({
    maxPerTxMinor: 10_000,
    dailyCapMinor: 50_000,
    allowedCurrencies: ['USD'],
    allowedMerchants: ['example.com'],
    requireHitlAboveMinor: 1_000,
  });

  const paymentProvider: PaymentProvider = createHitlCheckoutHandoffProvider(paymentGuard);

  const keys = generateA2AKeyPair();
  const a2a: TrustedA2APort = createTrustedA2AProtocol({
    selfId: 'self-agent',
    privateKeyPem: keys.privateKeyPem,
    peers: [
      {
        peerId: 'alice-agent',
        displayName: 'Alice',
        publicKeyPem: keys.publicKeyPem,
        allowedCapabilities: ['calendar:freebusy', 'schedule:propose'],
      },
    ],
  });

  const inboundPhone = createInboundPhoneService({
    websocketUrl: 'wss://nod.example.com/relay',
  });
  const virtualCards = createStripeIssuingProvider({ guard: paymentGuard });

  const turn = createMockTurn({
    sovereign: {
      stealthBrowser: fakeStealth,
      desktop: fakeDesktop,
      phoneConcierge: fakePhone,
      inboundPhone,
      virtualCards,
      paymentGuard,
      paymentProvider,
      a2a,
    },
  });

  const tools = nodTools(turn);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  assert.ok(toolMap.has('stealth_browse'));
  assert.ok(toolMap.has('desktop_control'));
  assert.ok(toolMap.has('concierge_call'));
  assert.ok(toolMap.has('checkout_payment'));
  assert.ok(toolMap.has('a2a_coordinate'));
  assert.ok(toolMap.has('issue_virtual_card'));
  assert.ok(toolMap.has('wait_for_sms_otp'));

  const stealthBrowse = toolMap.get('stealth_browse')!;
  const browseRes = (await stealthBrowse.execute({
    action: 'open',
    url: 'https://example.com',
  })) as string;
  assert.match(browseRes, /<untrusted_tool_result source="stealth_browser">/);
  assert.match(browseRes, /Opened https:\/\/example\.com/);

  const desktopControl = toolMap.get('desktop_control')!;
  const desktopRes = (await desktopControl.execute({
    action: 'snapshot',
    app: 'TestApp',
  })) as string;
  assert.match(desktopRes, /<untrusted_tool_result source="desktop_control">/);
  assert.match(desktopRes, /@s1:e1/);

  const phoneTool = toolMap.get('concierge_call')!;
  const unapprovedRes = (await phoneTool.execute({
    toNumber: '+15551234567',
    goal: 'Confirm dinner reservation',
  })) as { status: string; approvalTicket: string };
  assert.equal(unapprovedRes.status, 'requires_approval');
  assert.ok(unapprovedRes.approvalTicket.startsWith('call_req_'));

  const phoneRes = (await phoneTool.execute({
    toNumber: '+15551234567',
    goal: 'Confirm dinner reservation',
    approvalId: unapprovedRes.approvalTicket,
  })) as string;
  assert.match(phoneRes, /<untrusted_tool_result source="phone_concierge">/);
  assert.match(phoneRes, /CA_mock_1/);

  const paymentTool = toolMap.get('checkout_payment')!;
  const payRes = (await paymentTool.execute({
    amountMinor: 2500,
    currency: 'USD',
    merchantUrl: 'https://example.com/pay',
    description: 'Dinner invoice',
    channel: 'telegram',
  })) as {
    status: string;
    amountFormatted: string;
    cardTitle: string;
  };
  assert.equal(payRes.status, 'requires_approval');
  assert.equal(payRes.amountFormatted, '$25.00');
  assert.equal(payRes.cardTitle, 'Checkout approval: example.com');

  const a2aTool = toolMap.get('a2a_coordinate')!;
  const a2aRes = (await a2aTool.execute({
    recipientPeerId: 'alice-agent',
    capability: 'calendar:freebusy',
    payload: { date: '2026-11-13' },
  })) as {
    status: string;
    envelope: { signature: string; capability: string };
  };
  assert.equal(a2aRes.status, 'signed_and_ready');
  assert.equal(a2aRes.envelope.capability, 'calendar:freebusy');
  assert.ok(a2aRes.envelope.signature.length > 30);

  const virtualCardTool = toolMap.get('issue_virtual_card')!;
  const cardRes = (await virtualCardTool.execute({
    spendingLimitMinor: 500,
    currency: 'USD',
    merchantOrigin: 'https://example.com/checkout',
    description: 'Cloud subscription',
  })) as {
    status: string;
    last4: string;
    brand: string;
    autoFillReady: boolean;
  };
  assert.equal(cardRes.status, 'card_issued');
  assert.equal(cardRes.brand, 'visa');
  assert.equal(cardRes.autoFillReady, true);
  assert.equal(cardRes.last4.length, 4);

  await inboundPhone.handleInboundSms({
    messageSid: 'SM_test_otp_recent',
    from: '+15550198888',
    to: '+15550100000',
    body: 'Your Delta login code is 918234. Valid for 5 minutes.',
  });

  const otpTool = toolMap.get('wait_for_sms_otp')!;
  const otpRes = (await otpTool.execute({
    senderFilter: '5550198',
  })) as {
    status: string;
    code: string;
    sender: string;
  };
  assert.equal(otpRes.status, 'found_recent');
  assert.equal(otpRes.code, '918234');
});
