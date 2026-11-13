import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  PhoneCallApprovalError,
  PhoneCallProviderError,
  type ConversationRelayInbound,
  type ConversationRelayOutbound,
} from '../src/ports/phone-call.ts';
import {
  buildConversationRelayTwiml,
  createTwilioConciergeProvider,
  verifyTwilioSignature,
} from '../src/providers/twilio/concierge.ts';

function signTwilio(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join('');
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

test('buildConversationRelayTwiml renders default providers and escapes XML attributes', () => {
  const twiml = buildConversationRelayTwiml({
    url: 'wss://concierge.example.test/relay?a=1&b=2',
    welcomeGreeting: `Hello <Guest> & "Friends" at 'Nod'`,
    welcomeGreetingInterruptible: true,
    language: 'en-US',
    voice: 'Rachel&Co',
    interruptible: false,
    dtmfDetection: true,
    hints: `reservation, O'Connor & <VIP>`,
  });

  assert.match(twiml, /^<Response><Connect><ConversationRelay [^>]+><\/Connect><\/Response>$/);
  assert.ok(twiml.includes('url="wss://concierge.example.test/relay?a=1&amp;b=2"'));
  assert.ok(
    twiml.includes(
      'welcomeGreeting="Hello &lt;Guest&gt; &amp; &quot;Friends&quot; at &apos;Nod&apos;"',
    ),
  );
  assert.ok(twiml.includes('welcomeGreetingInterruptible="true"'));
  assert.ok(twiml.includes('language="en-US"'));
  assert.ok(twiml.includes('ttsProvider="ElevenLabs"'));
  assert.ok(twiml.includes('voice="Rachel&amp;Co"'));
  assert.ok(twiml.includes('transcriptionProvider="Deepgram"'));
  assert.ok(twiml.includes('interruptible="false"'));
  assert.ok(twiml.includes('dtmfDetection="true"'));
  assert.ok(twiml.includes('hints="reservation, O&apos;Connor &amp; &lt;VIP&gt;"'));
});

test('buildConversationRelayTwiml supports custom providers, parameters, and rejects blank url', () => {
  const twiml = buildConversationRelayTwiml({
    url: 'wss://concierge.example.test/ws',
    ttsProvider: 'Google',
    transcriptionProvider: 'Google',
    customParameters: {
      'tag&id': '<value>"quoted"',
    },
  });

  assert.ok(twiml.includes('ttsProvider="Google"'));
  assert.ok(twiml.includes('transcriptionProvider="Google"'));
  assert.ok(
    twiml.includes(
      '<Parameter name="tag&amp;id" value="&lt;value&gt;&quot;quoted&quot;"/>',
    ),
  );
  assert.throws(
    () => buildConversationRelayTwiml({ url: '   ' }),
    PhoneCallProviderError,
  );
});

test('verifyTwilioSignature validates sorted HMAC-SHA1 base64 signatures and rejects tampering', () => {
  const token = 'synthetic-twilio-auth-token';
  const url = 'https://concierge.example.test/webhooks/twilio/voice?step=1';
  const params = {
    To: '+15550100001',
    From: '+15550100002',
    CallSid: 'CA1234567890abcdef',
    AccountSid: 'AC00000000000000000000000000000000',
  };
  const validSignature = signTwilio(token, url, params);

  assert.equal(verifyTwilioSignature(token, validSignature, url, params), true);
  assert.equal(
    verifyTwilioSignature(token, signTwilio(token, url, {}), url, {}),
    true,
  );
  assert.equal(
    verifyTwilioSignature(token, validSignature, url, { ...params, To: '+15559999999' }),
    false,
  );
  assert.equal(
    verifyTwilioSignature(token, validSignature, `${url}&extra=1`, params),
    false,
  );
  assert.equal(
    verifyTwilioSignature('wrong-token', validSignature, url, params),
    false,
  );
  assert.equal(verifyTwilioSignature(token, 'not-valid-sig', url, params), false);
  assert.equal(verifyTwilioSignature('', validSignature, url, params), false);
  assert.equal(verifyTwilioSignature(token, '', url, params), false);
});

test('placeCall blocks unapproved or missing approvalId requests before making HTTP calls', async () => {
  let called = 0;
  const provider = createTwilioConciergeProvider({
    accountSid: 'AC00000000000000000000000000000000',
    authToken: 'synthetic-auth-token',
    fromNumber: '+15550100000',
    webhookBaseUrl: 'https://concierge.example.test/twilio',
    fetchImpl: async () => {
      called++;
      throw new Error('fetch should not be invoked');
    },
  });

  await assert.rejects(
    provider.placeCall({
      approved: false,
      approvalId: 'apr-1',
      to: '+15550109999',
      reason: 'Confirm dinner reservation',
    }),
    PhoneCallApprovalError,
  );

  await assert.rejects(
    provider.placeCall({
      approved: true,
      to: '+15550109999',
      reason: 'Confirm dinner reservation',
    }),
    PhoneCallApprovalError,
  );

  await assert.rejects(
    provider.placeCall({
      approved: true,
      approvalId: '   ',
      to: '+15550109999',
      reason: 'Confirm dinner reservation',
    }),
    PhoneCallApprovalError,
  );

  assert.equal(called, 0);
});

test('placeCall posts Basic-authenticated form-urlencoded call request via injected fetchImpl', async () => {
  const requests: Array<{
    url: string;
    method: string | undefined;
    authorization: string | null;
    contentType: string | null;
    body: string;
  }> = [];

  const provider = createTwilioConciergeProvider({
    accountSid: 'AC11111111111111111111111111111111',
    authToken: 'synthetic-secret-token',
    fromNumber: '+15550100000',
    webhookBaseUrl: 'https://concierge.example.test/webhooks/twilio/',
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        method: init?.method,
        authorization: headers.get('authorization'),
        contentType: headers.get('content-type'),
        body: String(init?.body ?? ''),
      });
      return new Response(
        JSON.stringify({
          sid: 'CA99999999999999999999999999999999',
          status: 'queued',
          to: '+15550109999',
          from: '+15550100000',
          date_created: '2026-11-11T17:30:00Z',
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });

  assert.equal(provider.configured, true);
  assert.equal(provider.id, 'twilio-concierge');

  const result = await provider.placeCall({
    approved: true,
    approvalId: 'apr-42',
    to: '+15550109999',
    reason: 'Book table for 2 at 7pm',
    welcomeGreeting: 'Hello, calling on behalf of Alex.',
    voice: 'Rachel',
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://api.twilio.com/2010-04-01/Accounts/AC11111111111111111111111111111111/Calls.json',
  );
  assert.equal(requests[0].method, 'POST');
  assert.equal(
    requests[0].authorization,
    `Basic ${Buffer.from('AC11111111111111111111111111111111:synthetic-secret-token').toString('base64')}`,
  );
  assert.equal(requests[0].contentType, 'application/x-www-form-urlencoded');

  const form = new URLSearchParams(requests[0].body);
  assert.equal(form.get('To'), '+15550109999');
  assert.equal(form.get('From'), '+15550100000');
  const twimlUrl = new URL(form.get('Url') ?? '');
  assert.equal(twimlUrl.origin + twimlUrl.pathname, 'https://concierge.example.test/webhooks/twilio/twiml');
  assert.equal(twimlUrl.searchParams.get('approvalId'), 'apr-42');
  assert.equal(twimlUrl.searchParams.get('welcomeGreeting'), 'Hello, calling on behalf of Alex.');
  assert.equal(twimlUrl.searchParams.get('voice'), 'Rachel');

  assert.deepEqual(result, {
    callSid: 'CA99999999999999999999999999999999',
    status: 'queued',
    to: '+15550109999',
    from: '+15550100000',
    approvalId: 'apr-42',
    createdAt: '2026-11-11T17:30:00Z',
  });

  const sigUrl = 'https://concierge.example.test/webhooks/twilio/twiml';
  const sig = signTwilio('synthetic-secret-token', sigUrl, { CallSid: 'CA1' });
  assert.equal(provider.verifyWebhookSignature(sig, sigUrl, { CallSid: 'CA1' }), true);
});

test('placeCall surfaces Twilio HTTP errors and rejects unconfigured provider', async () => {
  const failingProvider = createTwilioConciergeProvider({
    accountSid: 'AC11111111111111111111111111111111',
    authToken: 'synthetic-secret-token',
    fromNumber: '+15550100000',
    webhookBaseUrl: 'https://concierge.example.test',
    fetchImpl: async () => new Response('Authentication Error', { status: 401 }),
  });

  await assert.rejects(
    failingProvider.placeCall({
      approved: true,
      approvalId: 'apr-401',
      to: '+15550109999',
      reason: 'Confirm appointment',
    }),
    (error: unknown) =>
      error instanceof PhoneCallProviderError &&
      error.statusCode === 401 &&
      error.message.includes('401'),
  );

  const unconfigured = createTwilioConciergeProvider({
    accountSid: '',
    authToken: '',
    fromNumber: '',
    webhookBaseUrl: '',
  });
  assert.equal(unconfigured.configured, false);
  await assert.rejects(
    unconfigured.placeCall({
      approved: true,
      approvalId: 'apr-2',
      to: '+15550109999',
      reason: 'Test',
    }),
    PhoneCallProviderError,
  );
});

test('handleRelayMessage handles setup, prompt, interrupt, dtmf, error, and invalid payloads', async () => {
  const provider = createTwilioConciergeProvider({
    accountSid: 'AC11111111111111111111111111111111',
    authToken: 'synthetic-secret-token',
    fromNumber: '+15550100000',
    webhookBaseUrl: 'https://concierge.example.test',
  });

  const seenEvents: ConversationRelayInbound[] = [];
  const emitted: ConversationRelayOutbound[] = [];
  const prompts: string[] = [];

  const setupOut = await provider.handleRelayMessage(
    JSON.stringify({
      type: 'setup',
      sessionId: 'VX123',
      callSid: 'CA123',
      from: '+15550100000',
      to: '+15550109999',
    }),
    async (prompt) => {
      prompts.push(prompt.voicePrompt);
      return 'unexpected';
    },
    {
      onEvent: (event) => {
        seenEvents.push(event);
      },
      emit: (message) => {
        emitted.push(message);
      },
    },
  );
  assert.equal(setupOut, null);
  assert.equal(prompts.length, 0);

  const promptOut = await provider.handleRelayMessage(
    Buffer.from(
      JSON.stringify({
        type: 'prompt',
        voicePrompt: 'Do you have availability at 7pm?',
        lang: 'en-US',
        last: true,
      }),
      'utf8',
    ),
    async (prompt) => {
      prompts.push(prompt.voicePrompt);
      return 'Yes, a table for two at 7pm works.';
    },
    {
      onEvent: (event) => {
        seenEvents.push(event);
      },
      emit: (message) => {
        emitted.push(message);
      },
    },
  );
  assert.deepEqual(promptOut, {
    type: 'text',
    token: 'Yes, a table for two at 7pm works.',
    last: true,
  });
  assert.deepEqual(prompts, ['Do you have availability at 7pm?']);
  assert.deepEqual(emitted, [
    {
      type: 'text',
      token: 'Yes, a table for two at 7pm works.',
      last: true,
    },
  ]);

  const interruptOut = await provider.handleRelayMessage(
    JSON.stringify({
      type: 'interrupt',
      utteranceUntilInterrupt: 'Yes, a table',
      durationUntilInterruptMs: 650,
    }),
    () => 'should-not-run',
    {
      onEvent: (event) => {
        seenEvents.push(event);
      },
    },
  );
  assert.equal(interruptOut, null);

  const dtmfOut = await provider.handleRelayMessage(
    JSON.stringify({ type: 'dtmf', digit: '1' }),
    () => 'should-not-run',
    {
      onEvent: (event) => {
        seenEvents.push(event);
      },
    },
  );
  assert.equal(dtmfOut, null);

  const errorOut = await provider.handleRelayMessage(
    JSON.stringify({ type: 'error', description: 'ASR timeout', code: '31001' }),
    () => 'should-not-run',
    {
      onEvent: (event) => {
        seenEvents.push(event);
      },
    },
  );
  assert.equal(errorOut, null);

  assert.deepEqual(
    seenEvents.map((event) => event.type),
    ['setup', 'prompt', 'interrupt', 'dtmf', 'error'],
  );

  const customOutbound = await provider.handleRelayMessage(
    JSON.stringify({ type: 'prompt', voicePrompt: 'Goodbye' }),
    async () => ({ type: 'text', token: 'Thank you, goodbye.', last: false }),
  );
  assert.deepEqual(customOutbound, {
    type: 'text',
    token: 'Thank you, goodbye.',
    last: false,
  });

  const voidOutbound = await provider.handleRelayMessage(
    JSON.stringify({ type: 'prompt', voicePrompt: 'Silence' }),
    async () => {},
  );
  assert.equal(voidOutbound, null);

  await assert.rejects(
    provider.handleRelayMessage('not-json', () => 'unused'),
    PhoneCallProviderError,
  );
  await assert.rejects(
    provider.handleRelayMessage(JSON.stringify({ type: 'unknown' }), () => 'unused'),
    PhoneCallProviderError,
  );
});
