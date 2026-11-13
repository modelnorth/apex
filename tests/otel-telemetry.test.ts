import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import test from 'node:test';
import {
  addToolWarning,
  createAgentOtelTracer,
  extractTraceparent,
  injectTraceparent,
} from '../src/providers/otlp/tracer.ts';

interface CollectedAttribute {
  key: string;
  value: {
    stringValue?: string;
    boolValue?: boolean;
    intValue?: string;
    doubleValue?: number;
    arrayValue?: { values: { stringValue: string }[] };
  };
}

interface CollectedEvent {
  timeUnixNano: string;
  name: string;
  attributes: CollectedAttribute[];
}

interface CollectedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: CollectedAttribute[];
  events: CollectedEvent[];
  status: {
    code: number;
    message?: string;
  };
}

interface CollectedPayload {
  resourceSpans: Array<{
    resource: { attributes: CollectedAttribute[] };
    scopeSpans: Array<{
      scope: { name: string; version?: string };
      spans: CollectedSpan[];
    }>;
  }>;
}

interface ReceivedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  payload: CollectedPayload;
}

async function startCollectorServer() {
  const requests: ReceivedRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      payload: JSON.parse(body) as CollectedPayload,
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function attrMap(attributes: CollectedAttribute[]): Map<string, CollectedAttribute['value']> {
  return new Map(attributes.map((entry) => [entry.key, entry.value]));
}

test('delivers OTLP /v1/traces payload with hierarchical spans and GenAI v1.28.0+ attributes', async (t) => {
  const collector = await startCollectorServer();
  t.after(() => collector.close());

  const tracer = createAgentOtelTracer({
    serviceName: 'nod-agent-runtime',
    endpoint: collector.url,
    headers: { 'x-collector-auth': 'collector-secret-header' },
  });

  const sessionSpan = tracer.startSpan({
    operation: 'session',
    name: 'agent.session',
    system: 'anthropic',
  });

  const chatSpan = tracer.startSpan({
    operation: 'chat',
    parent: sessionSpan,
    system: 'anthropic',
    requestModel: 'claude-3-7-sonnet',
  });

  const toolSpan = tracer.startSpan({
    operation: 'execute_tool',
    parent: chatSpan,
    toolName: 'read_file',
    toolCallId: 'call_abc123',
  });
  toolSpan.end({ durationMs: 45 });

  chatSpan.end({
    responseModel: 'claude-3-7-sonnet-20250219',
    inputTokens: 1420,
    outputTokens: 310,
    finishReasons: ['tool_use'],
    costDollars: 0.0089,
    ttftMs: 250,
    durationMs: 1250,
  });

  sessionSpan.end({ status: 'ok', durationMs: 1400 });

  await tracer.flush();
  await tracer.shutdown();

  assert.equal(collector.requests.length, 1);
  const req = collector.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/v1/traces');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(req.headers['x-collector-auth'], 'collector-secret-header');

  const resourceAttrs = attrMap(req.payload.resourceSpans[0].resource.attributes);
  assert.equal(resourceAttrs.get('service.name')?.stringValue, 'nod-agent-runtime');

  const spans = req.payload.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 3);

  const [tool, chat, session] = spans;
  assert.equal(session.parentSpanId, undefined);
  assert.equal(chat.traceId, session.traceId);
  assert.equal(chat.parentSpanId, session.spanId);
  assert.equal(tool.traceId, session.traceId);
  assert.equal(tool.parentSpanId, chat.spanId);

  assert.match(session.traceId, /^[0-9a-f]{32}$/);
  assert.match(session.spanId, /^[0-9a-f]{16}$/);
  assert.ok(BigInt(chat.endTimeUnixNano) > BigInt(chat.startTimeUnixNano));

  const chatAttrs = attrMap(chat.attributes);
  assert.equal(chatAttrs.get('gen_ai.operation.name')?.stringValue, 'chat');
  assert.equal(chatAttrs.get('gen_ai.system')?.stringValue, 'anthropic');
  assert.equal(chatAttrs.get('gen_ai.request.model')?.stringValue, 'claude-3-7-sonnet');
  assert.equal(chatAttrs.get('gen_ai.response.model')?.stringValue, 'claude-3-7-sonnet-20250219');
  assert.equal(chatAttrs.get('gen_ai.usage.input_tokens')?.intValue, '1420');
  assert.equal(chatAttrs.get('gen_ai.usage.output_tokens')?.intValue, '310');
  assert.deepEqual(
    chatAttrs.get('gen_ai.response.finish_reasons')?.arrayValue?.values.map((v) => v.stringValue),
    ['tool_use'],
  );
  assert.equal(chatAttrs.get('gen_ai.cost.dollars')?.doubleValue, 0.0089);
  assert.equal(chatAttrs.get('agent.ttft_ms')?.doubleValue, 250);
  assert.equal(chatAttrs.get('agent.duration_ms')?.doubleValue, 1250);
  assert.equal(chatAttrs.get('agent.otps')?.doubleValue, 310);

  const toolAttrs = attrMap(tool.attributes);
  assert.equal(tool.name, 'tool:read_file');
  assert.equal(toolAttrs.get('gen_ai.operation.name')?.stringValue, 'execute_tool');
  assert.equal(toolAttrs.get('gen_ai.tool.name')?.stringValue, 'read_file');
  assert.equal(toolAttrs.get('gen_ai.tool.call_id')?.stringValue, 'call_abc123');
  assert.equal(toolAttrs.get('agent.duration_ms')?.doubleValue, 45);
});

test('propagates W3C traceparent across subagent process boundaries and supports withSpan nesting', async (t) => {
  const collector = await startCollectorServer();
  t.after(() => collector.close());

  const parentTracer = createAgentOtelTracer({
    serviceName: 'nod-parent',
    endpoint: `${collector.url}/v1/traces`,
  });
  const subagentTracer = createAgentOtelTracer({
    serviceName: 'nod-subagent',
    endpoint: `${collector.url}/otel`,
  });

  let carrier = {};
  await parentTracer.withSpan({ operation: 'session', name: 'root.session' }, async (rootSpan) => {
    await parentTracer.withSpan(
      { operation: 'chat', requestModel: 'gemini-2.5-pro', system: 'google' },
      async (chatSpan) => {
        assert.equal(chatSpan.traceId, rootSpan.traceId);
        assert.equal(chatSpan.parentSpanId, rootSpan.spanId);
        carrier = parentTracer.injectTraceparent(chatSpan);
      },
    );
  });

  assert.match(
    (carrier as { traceparent: string }).traceparent,
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
  );

  const extracted = subagentTracer.extractTraceparent({
    Traceparent: (carrier as { traceparent: string }).traceparent,
  });
  assert.ok(extracted);

  await subagentTracer.withSpan(
    { operation: 'subagent', name: 'worker.subagent', carrier },
    async (subSpan) => {
      assert.equal(subSpan.traceId, extracted.traceId);
      assert.equal(subSpan.parentSpanId, extracted.spanId);
      await subagentTracer.withSpan(
        { operation: 'execute_tool', toolName: 'sql_query', toolCallId: 'call_sub_1' },
        async (toolSpan) => {
          assert.equal(toolSpan.traceId, extracted.traceId);
          assert.equal(toolSpan.parentSpanId, subSpan.spanId);
        },
      );
    },
  );

  await parentTracer.shutdown();
  await subagentTracer.shutdown();

  assert.equal(collector.requests.length, 2);
  assert.equal(collector.requests[0].url, '/v1/traces');
  assert.equal(collector.requests[1].url, '/otel/v1/traces');

  const parentSpans = collector.requests[0].payload.resourceSpans[0].scopeSpans[0].spans;
  const subSpans = collector.requests[1].payload.resourceSpans[0].scopeSpans[0].spans;
  const parentChat = parentSpans.find((s) => s.name === 'chat');
  const workerSubagent = subSpans.find((s) => s.name === 'worker.subagent');
  const workerTool = subSpans.find((s) => s.name === 'tool:sql_query');

  assert.ok(parentChat && workerSubagent && workerTool);
  assert.equal(workerSubagent.traceId, parentChat.traceId);
  assert.equal(workerSubagent.parentSpanId, parentChat.spanId);
  assert.equal(workerTool.traceId, parentChat.traceId);
  assert.equal(workerTool.parentSpanId, workerSubagent.spanId);

  assert.equal(extractTraceparent({}), undefined);
  assert.equal(
    extractTraceparent({ traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' }),
    undefined,
  );
  assert.equal(
    extractTraceparent({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01' }),
    undefined,
  );
  assert.equal(
    extractTraceparent({ traceparent: 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }),
    undefined,
  );
  assert.deepEqual(
    injectTraceparent({
      traceId: '00000000000000000000000000000000',
      spanId: '00f067aa0ba902b7',
    }),
    {},
  );
});

test('scrubs sensitive keys, op:// references, Bearer tokens, >=32-char secrets, and truncates >2048-char strings', async (t) => {
  const collector = await startCollectorServer();
  t.after(() => collector.close());

  const tracer = createAgentOtelTracer({
    serviceName: 'nod-scrub-test',
    endpoint: collector.url,
  });

  const longSecret = 'mock_secret_key_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const longProse = 'safe prose entry '.repeat(200);
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

  const span = tracer.startSpan({
    operation: 'execute_tool',
    toolName: 'http_fetch',
    inputTokens: 100,
    outputTokens: 50,
    attributes: {
      apiKey: 'plain-api-key',
      access_token: 'plain-access-token',
      clientSecret: 'plain-secret',
      db_password: 'hunter2password',
      authorization: 'Basic dXNlcjpwYXNz',
      'set-cookie': 'session=xyz',
      card_cvv: 999,
      cardPan: '4111111111111111',
      'agent.span_kind': 'internal',
      'agent.op_ref': 'using op://Production/Stripe/api_key for billing',
      'agent.bearer_header': 'Header was Bearer super-secret-jwt-value',
      'agent.payload': `leaked=${longSecret}`,
      'agent.jwt': jwt,
      'agent.long_prose': longProse,
      'agent.safe_path': 'src/providers/otlp/tracer.ts',
    },
  });
  span.setAttribute('custom_token', 'abc');
  span.end({ status: 'ok', otps: 88.5, ttftMs: 120, durationMs: 600 });

  await tracer.shutdown();

  const emitted = collector.requests[0].payload.resourceSpans[0].scopeSpans[0].spans[0];
  const attrs = attrMap(emitted.attributes);

  assert.equal(attrs.get('gen_ai.usage.input_tokens')?.intValue, '100');
  assert.equal(attrs.get('gen_ai.usage.output_tokens')?.intValue, '50');
  assert.equal(attrs.get('agent.otps')?.doubleValue, 88.5);
  assert.equal(attrs.get('agent.ttft_ms')?.doubleValue, 120);
  assert.equal(attrs.get('agent.duration_ms')?.doubleValue, 600);

  for (const redactedKey of [
    'apiKey',
    'access_token',
    'clientSecret',
    'db_password',
    'authorization',
    'set-cookie',
    'card_cvv',
    'cardPan',
    'custom_token',
  ]) {
    assert.equal(attrs.get(redactedKey)?.stringValue, '[REDACTED]', `expected ${redactedKey} redacted`);
  }

  assert.equal(attrs.get('agent.span_kind')?.stringValue, 'internal');
  assert.equal(attrs.get('agent.safe_path')?.stringValue, 'src/providers/otlp/tracer.ts');
  assert.equal(attrs.get('agent.op_ref')?.stringValue, 'using [REDACTED] for billing');
  assert.equal(attrs.get('agent.bearer_header')?.stringValue, 'Header was Bearer [REDACTED]');
  assert.equal(attrs.get('agent.payload')?.stringValue, 'leaked=[REDACTED]');
  assert.equal(attrs.get('agent.jwt')?.stringValue, '[REDACTED]');

  const truncated = attrs.get('agent.long_prose')?.stringValue ?? '';
  assert.equal(truncated.length, 2048);
  assert.ok(truncated.startsWith('safe prose entry '));
});

test('records soft tool warnings without fatal error status and sets error status on unhandled failures', async (t) => {
  const collector = await startCollectorServer();
  t.after(() => collector.close());

  const tracer = createAgentOtelTracer({
    serviceName: 'nod-status-test',
    endpoint: collector.url,
  });

  const softSpan = tracer.startSpan({
    operation: 'execute_tool',
    toolName: 'read_file',
    toolCallId: 'call_soft_1',
  });
  addToolWarning(softSpan, 'ENOENT using Bearer secret-token-value', { retryable: true });
  softSpan.end({ durationMs: 12 });

  await assert.rejects(
    () =>
      tracer.withSpan({ operation: 'chat', requestModel: 'claude-3-7-sonnet' }, async () => {
        throw new Error('Fatal failure with op://Vault/Item/Key');
      }),
    /Fatal failure/,
  );

  await tracer.shutdown();

  const spans = collector.requests[0].payload.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2);

  const [softEmitted, fatalEmitted] = spans;
  assert.notEqual(softEmitted.status.code, 2);
  assert.equal(softEmitted.events.length, 1);
  assert.equal(softEmitted.events[0].name, 'tool_warning');
  const warningAttrs = attrMap(softEmitted.events[0].attributes);
  assert.equal(warningAttrs.get('error')?.stringValue, 'ENOENT using Bearer [REDACTED]');
  assert.equal(warningAttrs.get('retryable')?.boolValue, true);

  assert.equal(fatalEmitted.status.code, 2);
  assert.equal(fatalEmitted.status.message, 'Fatal failure with [REDACTED]');
  assert.equal(fatalEmitted.events[0].name, 'exception');
  const excAttrs = attrMap(fatalEmitted.events[0].attributes);
  assert.equal(excAttrs.get('exception.message')?.stringValue, 'Fatal failure with [REDACTED]');
});

test('validates endpoint URLs and supports no-op mode without endpoint', async () => {
  assert.throws(
    () => createAgentOtelTracer({ endpoint: 'ftp://collector.invalid' }),
    /HTTP or HTTPS/,
  );
  assert.throws(
    () => createAgentOtelTracer({ endpoint: 'http://user:pass@127.0.0.1:4318' }),
    /without credentials/,
  );
  assert.throws(
    () => createAgentOtelTracer({ endpoint: 'http://127.0.0.1:4318?token=abc' }),
    /queries or fragments/,
  );

  const noopTracer = createAgentOtelTracer({ serviceName: 'noop' });
  const span = noopTracer.startSpan({ operation: 'session' });
  span.end();
  await noopTracer.flush();
  await noopTracer.shutdown();
});
