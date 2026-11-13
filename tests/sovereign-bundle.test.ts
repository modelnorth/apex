import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createSovereignCapabilities } from '../src/server/composition.ts';
import { createBrowserbaseCliProvider } from '../src/providers/browserbase/client.ts';
import { generateA2AKeyPair } from '../src/providers/a2a/protocol.ts';
import { buildConversationRelayTwiml } from '../src/providers/twilio/concierge.ts';

test('createSovereignCapabilities executes full Instinct-killer workflow with OTel tracing', async () => {
  const collectedSpans: Array<{ traceId: string; spanId: string; parentSpanId?: string; name: string }> = [];
  const collector = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: typeof collectedSpans }> }>;
    };
    for (const rs of body.resourceSpans) {
      for (const ss of rs.scopeSpans) {
        collectedSpans.push(...ss.spans);
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  collector.listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const address = collector.address();
  assert.ok(address && typeof address !== 'string');
  const otlpEndpoint = `http://127.0.0.1:${address.port}`;

  const peerKeys = generateA2AKeyPair();
  const selfKeys = generateA2AKeyPair();

  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    if (url.startsWith(otlpEndpoint)) {
      return fetch(input, init);
    }
    if (parsed.hostname === 'api.twilio.com') {
      return new Response(
        JSON.stringify({ sid: 'CA_sovereign_1', status: 'queued', to: '+15550109999', from: '+15550100001' }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    if (parsed.hostname === 'api.stripe.com' && parsed.pathname.startsWith('/v1/payment_intents')) {
      return new Response(
        JSON.stringify({ id: 'pi_sovereign_1', status: 'succeeded', amount: 4500, currency: 'usd', livemode: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const capabilities = createSovereignCapabilities({
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint,
      STRIPE_SECRET_KEY: 'sk_test_sovereign_mock',
      STRIPE_ACCOUNT_ID: 'acct_test_1',
      TWILIO_ACCOUNT_SID: 'AC_test_1',
      TWILIO_AUTH_TOKEN: 'twilio_auth_token_test',
      TWILIO_FROM_NUMBER: '+15550100001',
      NOD_PUBLIC_URL: 'https://nod.example.com',
    },
    spendPolicy: {
      maxPerTxMinor: 10_000,
      dailyCapMinor: 50_000,
      allowedCurrencies: ['USD'],
      allowedMerchants: ['https://checkout.example.com'],
      requireHitlAboveMinor: 1_000,
    },
    geofenceZones: [
      {
        id: 'office',
        label: 'Downtown Office',
        lat: 25.2048,
        lon: 55.2708,
        radiusMeters: 250,
        triggerOn: 'enter',
      },
    ],
    a2aSelfId: 'nod-self',
    a2aPrivateKeyPem: selfKeys.privateKeyPem,
    a2aPeers: [
      {
        peerId: 'trusted-alice',
        displayName: 'Alice Nod',
        publicKeyPem: peerKeys.publicKeyPem,
        allowedCapabilities: ['calendar:freebusy', 'schedule:propose'],
      },
    ],
    fetchImpl: fetchMock,
  });

  try {
    await capabilities.tracer.withSpan(
      { name: 'session:errand', operation: 'session', attributes: { apiKey: 'super_secret_should_redact_1234567890' } },
      async (rootSpan) => {
        const ingested = capabilities.locationObserver.ingest({
          _type: 'location',
          lat: 25.2049,
          lon: 55.2709,
          acc: 12,
          tst: Math.floor(Date.now() / 1000),
        });
        assert.equal(ingested.accepted, true);
        assert.equal(ingested.transitions.length, 1);
        assert.equal(ingested.transitions[0]?.data.zoneId, 'office');
        assert.equal('lat' in (ingested.transitions[0]?.data ?? {}), false);

        const carrier = capabilities.tracer.injectTraceparent(rootSpan);
        assert.match(carrier.traceparent ?? '', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

        await capabilities.tracer.withSpan(
          {
            name: 'subagent:a2a-negotiate',
            operation: 'subagent',
            carrier,
          },
          async () => {
            const peerProtocol = await import('../src/providers/a2a/protocol.ts').then((m) =>
              m.createTrustedA2AProtocol({
                selfId: 'trusted-alice',
                privateKeyPem: peerKeys.privateKeyPem,
                peers: [
                  {
                    peerId: 'nod-self',
                    displayName: 'Self Nod',
                    publicKeyPem: selfKeys.publicKeyPem,
                    allowedCapabilities: ['calendar:freebusy'],
                  },
                ],
              }),
            );
            const envFromPeer = peerProtocol.signEnvelope(
              'calendar:freebusy',
              { busy: [{ startMs: 1_000_000, endMs: 1_900_000 }] },
              'nod-self',
            );
            const verified = capabilities.a2a.verifyEnvelope(envFromPeer);
            assert.equal(verified.ok, true);
            assert.equal(verified.untrustedData, true);
          },
        );

        const intent = {
          intentId: 'intent-1',
          merchant: 'Example Store',
          merchantOrigin: 'https://checkout.example.com',
          amountMinor: 4500,
          currency: 'USD',
          description: 'Team lunch',
          checkoutUrl: 'https://checkout.example.com/pay/1',
          expiresAt: Date.now() + 60_000,
        };
        const handoff = await capabilities.hitlCheckout.createCheckoutHandoff(intent);
        assert.equal(handoff.cardDataIncluded, false);
        assert.equal(handoff.channels.telegram.actionUrl, 'https://checkout.example.com/pay/1');

        const payResult = await capabilities.paymentProvider.execute(intent, {
          approvalId: 'appr-1',
          intentId: 'intent-1',
          approvedBy: 'owner',
          approvedAt: Date.now(),
          singleUse: true,
        });
        assert.equal(payResult.status, 'succeeded');
        assert.equal(capabilities.paymentGuard.dailySpentMinor(), 4500);

        assert.ok(capabilities.phoneConcierge);
        const call = await capabilities.phoneConcierge.placeCall({
          to: '+15550109999',
          reason: 'Confirm table reservation',
          welcomeGreeting: 'Hello from Nod',
          approved: true,
          approvalId: 'call-appr-1',
        });
        assert.equal(call.callSid, 'CA_sovereign_1');
        const twiml = buildConversationRelayTwiml({
          url: 'wss://nod.example.com/voice',
          welcomeGreeting: 'Hello',
        });
        assert.match(twiml, /<ConversationRelay /);

        const desktopStatus = await capabilities.desktop.status();
        assert.equal(typeof desktopStatus.ok, 'boolean');

        assert.ok(capabilities.inboundPhone);
        const smsUrl = 'https://nod.example.com/sms';
        const smsPayload = {
          messageSid: 'SM_bundle_1',
          from: '+15550198888',
          to: '+15550100001',
          body: 'Your Delta security code is 582910. Expires in 10 minutes.',
        };
        const sigString = `${smsUrl}Body${smsPayload.body}From${smsPayload.from}MessageSid${smsPayload.messageSid}To${smsPayload.to}`;
        const validSig = createHmac('sha1', 'twilio_auth_token_test').update(sigString, 'utf8').digest('base64');
        const smsRes = await capabilities.inboundPhone.handleInboundSms(
          smsPayload,
          validSig,
          smsUrl,
        );
        assert.equal(smsRes.otp?.code, '582910');

        const card = await capabilities.virtualCards.issueCard({
          spendingLimitMinor: 500,
          currency: 'USD',
          merchantOrigin: 'https://checkout.example.com',
          description: 'Flight add-on',
        });
        assert.equal(card.status, 'active');
        assert.equal(card.last4.length, 4);
      },
    );

    await capabilities.tracer.flush();
    assert.equal(collectedSpans.length, 2);
    const root = collectedSpans.find((s) => s.name === 'session:errand');
    const child = collectedSpans.find((s) => s.name === 'subagent:a2a-negotiate');
    assert.ok(root && child);
    assert.equal(child.traceId, root.traceId);
    assert.equal(child.parentSpanId, root.spanId);
  } finally {
    await capabilities.shutdown();
    collector.close();
  }
});

const playwrightChrome =
  'C:\\Users\\DELL\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

test(
  'BrowserbaseCliProvider executes real local open, title, and stop against Chromium',
  { skip: !existsSync(playwrightChrome), timeout: 30_000 },
  async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Sovereign Local Test</title></head><body><h1>Ready</h1></body></html>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    const url = `http://127.0.0.1:${addr.port}/`;
    const browser = createBrowserbaseCliProvider({
      chromePath: playwrightChrome,
      defaultMode: 'local',
    });
    try {
      const opened = await browser.open(url, { session: 'sovereign-e2e' });
      assert.equal(opened.mode, 'local');
      assert.equal(opened.challenge, 'none');
      const title = await browser.title({ session: 'sovereign-e2e' });
      assert.equal(title, 'Sovereign Local Test');
    } finally {
      await browser.stop({ session: 'sovereign-e2e' }).catch(() => {});
      server.close();
    }
  },
);
