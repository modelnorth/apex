import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOtpFromText,
  createInboundPhoneService,
  TwilioInboundPhoneService,
} from '../src/providers/twilio/inbound.ts';
import type { PhoneCallProvider } from '../src/ports/phone-call.ts';

test('extractOtpFromText extracts multi-format SMS verification codes', () => {
  assert.equal(extractOtpFromText('Your verification code is 849201. Do not share.'), '849201');
  assert.equal(extractOtpFromText('123456 is your Airbnb verification code.'), '123456');
  assert.equal(extractOtpFromText('G-948201 is your Google verification code'), '948201');
  assert.equal(extractOtpFromText('Your security code: 482910'), '482910');
  assert.equal(extractOtpFromText('Use passcode 5543 to login'), '5543');
  assert.equal(extractOtpFromText('Delta flight 2024 is on schedule.'), null);
  assert.equal(extractOtpFromText('Hello there! How are you today?'), null);
});

test('handleInboundVoice renders ConversationRelay TwiML and isolates caller metadata', async () => {
  const service = createInboundPhoneService({
    websocketUrl: 'wss://nod.example.com/relay',
    welcomeGreeting: 'Welcome to sovereign concierge',
  });

  const res = await service.handleInboundVoice({
    callSid: 'CA_inbound_1',
    from: '+15550199999',
    to: '+15550100000',
    callStatus: 'ringing',
    direction: 'inbound',
  });

  assert.match(res.twiml, /<ConversationRelay /);
  assert.match(res.twiml, /url="wss:\/\/nod\.example\.com\/relay"/);
  assert.match(res.twiml, /Welcome to sovereign concierge/);
  assert.match(res.untrustedPayload, /<untrusted_tool_result source="twilio_inbound_voice">/);
  assert.match(res.untrustedPayload, /CA_inbound_1/);
});

test('handleInboundVoice verifies Twilio HMAC signature when configured', async () => {
  const mockProvider: PhoneCallProvider = {
    id: 'twilio-mock',
    configured: true,
    placeCall: async () => {
      throw new Error('Not used in test');
    },
    buildTwiml: () => '<Response />',
    verifyWebhookSignature: (sig) => sig === 'valid_signature',
    handleRelayMessage: async () => null,
  };

  const service = new TwilioInboundPhoneService({
    provider: mockProvider,
    authToken: 'secret_token',
    websocketUrl: 'wss://nod.example.com/relay',
  });

  await assert.rejects(
    async () => {
      await service.handleInboundVoice(
        {
          callSid: 'CA_inbound_2',
          from: '+15550199999',
          to: '+15550100000',
          callStatus: 'ringing',
          direction: 'inbound',
        },
        'invalid_signature',
        'https://nod.example.com/voice',
      );
    },
    { message: 'Twilio inbound voice signature verification failed' },
  );

  await assert.rejects(
    async () => {
      await service.handleInboundVoice(
        {
          callSid: 'CA_inbound_2',
          from: '+15550199999',
          to: '+15550100000',
          callStatus: 'ringing',
          direction: 'inbound',
        },
        undefined,
        'https://nod.example.com/voice',
      );
    },
    { message: 'Twilio inbound voice signature verification failed' },
  );

  const validRes = await service.handleInboundVoice(
    {
      callSid: 'CA_inbound_2',
      from: '+15550199999',
      to: '+15550100000',
      callStatus: 'ringing',
      direction: 'inbound',
    },
    'valid_signature',
    'https://nod.example.com/voice',
  );
  assert.ok(validRes.twiml);
});

test('handleInboundSms captures 2FA OTP and fulfills waitForOtp promise', async () => {
  const service = createInboundPhoneService({
    websocketUrl: 'wss://nod.example.com/relay',
  });

  const otpPromise = service.waitForOtp({
    timeoutMs: 5000,
    senderPattern: /5550199/,
  });

  const smsRes = await service.handleInboundSms({
    messageSid: 'SM_test_1',
    from: '+15550199888',
    to: '+15550100000',
    body: 'Your Delta security code is 739201. Expires in 10 minutes.',
  });

  assert.equal(smsRes.received, true);
  assert.equal(smsRes.otp?.code, '739201');
  assert.match(smsRes.untrustedPayload, /<untrusted_tool_result source="twilio_inbound_sms">/);

  const awaitedOtp = await otpPromise;
  assert.equal(awaitedOtp.code, '739201');
  assert.equal(awaitedOtp.sender, '+15550199888');

  const recent = service.getRecentOtp();
  assert.equal(recent?.code, '739201');
});

test('waitForOtp times out or aborts when signal triggered', async () => {
  const service = createInboundPhoneService({
    websocketUrl: 'wss://nod.example.com/relay',
  });

  const controller = new AbortController();
  const waitPromise = service.waitForOtp({ timeoutMs: 1000, signal: controller.signal });
  controller.abort();

  await assert.rejects(waitPromise, { message: 'Operation aborted' });
});
