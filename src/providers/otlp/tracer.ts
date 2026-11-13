import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type {
  AgentSpanEndOptions,
  AgentSpanHandle,
  AgentSpanOptions,
  AgentTracer,
  GenAiOperationName,
  TraceAttributeValue,
  TraceCarrier,
  TraceContext,
} from '../../ports/telemetry.ts';

export interface AgentOtelTracerOptions {
  serviceName?: string;
  endpoint?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  scopeName?: string;
  scopeVersion?: string;
  flushIntervalMs?: number;
  maxQueueSize?: number;
}

type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: { stringValue: string }[] } };

interface OtlpAttribute {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpSpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: OtlpAttribute[];
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  events: OtlpSpanEvent[];
  status: {
    code: 0 | 1 | 2;
    message?: string;
  };
}

const REDACTED = '[REDACTED]';
const MAX_STRING_LENGTH = 2048;

const SAFE_GEN_AI_KEYS = new Set([
  'gen_ai.operation.name',
  'gen_ai.system',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_creation.input_tokens',
  'gen_ai.response.finish_reasons',
  'gen_ai.tool.name',
  'gen_ai.tool.call_id',
  'gen_ai.cost.dollars',
  'agent.ttft_ms',
  'agent.otps',
  'agent.duration_ms',
]);

const INTEGER_ATTRIBUTES = new Set([
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_creation.input_tokens',
]);

const SENSITIVE_KEY_WORDS = new Set([
  'token',
  'key',
  'apikey',
  'secret',
  'secrets',
  'password',
  'passwords',
  'authorization',
  'cookie',
  'cookies',
  'cvv',
  'pan',
]);

const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|authorization|cookie|cvv|apikey)/i;
const TRACEPARENT_V00_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const TRACEPARENT_ANY_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/i;
const TRACE_ID_REGEX = /^[0-9a-f]{32}$/i;
const SPAN_ID_REGEX = /^[0-9a-f]{16}$/i;
const TRACE_FLAGS_REGEX = /^[0-9a-f]{2}$/i;

function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitiveKey(key: string): boolean {
  if (SAFE_GEN_AI_KEYS.has(key)) return false;
  if (SENSITIVE_KEY_PATTERN.test(key)) return true;
  return splitKeyWords(key).some((word) => SENSITIVE_KEY_WORDS.has(word));
}

export function scrubString(value: string): string {
  let scrubbed = value
    .replace(/op:\/\/[^\s"'`<>]+/gi, REDACTED)
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED)
    .replace(/[A-Za-z0-9_-]{32,}={0,2}/g, REDACTED);
  if (scrubbed.length > MAX_STRING_LENGTH) {
    scrubbed = scrubbed.slice(0, MAX_STRING_LENGTH);
  }
  return scrubbed;
}

function encodeAttribute(key: string, value: TraceAttributeValue | undefined): OtlpAttribute | undefined {
  if (value === undefined) return undefined;
  if (isSensitiveKey(key)) {
    return { key, value: { stringValue: REDACTED } };
  }
  if (typeof value === 'string') {
    return { key, value: { stringValue: scrubString(value) } };
  }
  if (typeof value === 'boolean') {
    return { key, value: { boolValue: value } };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (INTEGER_ATTRIBUTES.has(key)) {
      return { key, value: { intValue: String(Math.floor(value)) } };
    }
    return { key, value: { doubleValue: value } };
  }
  if (Array.isArray(value)) {
    return {
      key,
      value: {
        arrayValue: {
          values: value.map((item) => ({ stringValue: scrubString(String(item)) })),
        },
      },
    };
  }
  return undefined;
}

function encodeAttributesRecord(
  record?: Record<string, TraceAttributeValue | undefined>,
): OtlpAttribute[] {
  if (!record) return [];
  const encoded: OtlpAttribute[] = [];
  for (const [key, value] of Object.entries(record)) {
    const attr = encodeAttribute(key, value);
    if (attr) encoded.push(attr);
  }
  return encoded;
}

function validateOtlpEndpoint(endpoint?: string): URL | undefined {
  if (!endpoint?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      'The OTLP endpoint must use HTTP or HTTPS without credentials, queries or fragments.',
    );
  }
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = normalizedPath.endsWith('/v1/traces')
    ? normalizedPath
    : `${normalizedPath}/v1/traces`;
  return url;
}

function defaultSpanKind(operation: GenAiOperationName): number {
  if (operation === 'chat' || operation === 'execute_tool') return 3;
  return 1;
}

function defaultSpanName(options: AgentSpanOptions): string {
  if (options.name?.trim()) return options.name.trim();
  if (options.operation === 'execute_tool' && options.toolName?.trim()) {
    return `tool:${options.toolName.trim()}`;
  }
  return options.operation;
}

function isValidHexId(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && !/^0+$/.test(value);
}

export function injectTraceparent(ctx: TraceContext | AgentSpanHandle): TraceCarrier {
  const traceId = ctx.traceId.toLowerCase();
  const spanId = ctx.spanId.toLowerCase();
  const rawFlags = 'traceFlags' in ctx && ctx.traceFlags ? ctx.traceFlags.toLowerCase() : '01';
  const traceFlags = TRACE_FLAGS_REGEX.test(rawFlags) ? rawFlags : '01';
  if (!isValidHexId(traceId, TRACE_ID_REGEX) || !isValidHexId(spanId, SPAN_ID_REGEX)) {
    return {};
  }
  return {
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
  };
}

export function extractTraceparent(carrier: TraceCarrier): TraceContext | undefined {
  let raw: string | undefined;
  for (const [key, value] of Object.entries(carrier)) {
    if (key.toLowerCase() === 'traceparent' && typeof value === 'string') {
      raw = value.trim();
      break;
    }
  }
  if (!raw) return undefined;
  const v00 = TRACEPARENT_V00_REGEX.exec(raw);
  if (v00) {
    const [, traceId, spanId, traceFlags] = v00;
    if (!isValidHexId(traceId, TRACE_ID_REGEX) || !isValidHexId(spanId, SPAN_ID_REGEX)) {
      return undefined;
    }
    return {
      traceId: traceId.toLowerCase(),
      spanId: spanId.toLowerCase(),
      traceFlags: traceFlags.toLowerCase(),
    };
  }
  const anyVersion = TRACEPARENT_ANY_REGEX.exec(raw);
  if (!anyVersion) return undefined;
  const [, version, traceId, spanId, traceFlags] = anyVersion;
  const lowerVersion = version.toLowerCase();
  if (lowerVersion === 'ff' || lowerVersion === '00') return undefined;
  if (!isValidHexId(traceId, TRACE_ID_REGEX) || !isValidHexId(spanId, SPAN_ID_REGEX)) {
    return undefined;
  }
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    traceFlags: traceFlags.toLowerCase(),
  };
}

export function addToolWarning(
  span: AgentSpanHandle,
  message: string,
  attributes?: Record<string, TraceAttributeValue | undefined>,
): void {
  span.addEvent('tool_warning', {
    ...attributes,
    error: message,
  });
}

export function createAgentOtelTracer(options?: AgentOtelTracerOptions): AgentTracer {
  const serviceName = options?.serviceName?.trim() || 'nod';
  const scopeName = options?.scopeName?.trim() || 'nod.agent';
  const scopeVersion = options?.scopeVersion?.trim() || '1.0.0';
  const url = validateOtlpEndpoint(options?.endpoint);
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const maxQueueSize = options?.maxQueueSize ?? 512;
  const flushIntervalMs = options?.flushIntervalMs ?? 5_000;

  const requestHeaders: Record<string, string> = {};
  if (options?.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      if (value !== undefined) requestHeaders[key] = value;
    }
  }
  if (!Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-type')) {
    requestHeaders['content-type'] = 'application/json';
  }

  const activeSpanStorage = new AsyncLocalStorage<AgentSpanHandle>();
  const queue: OtlpSpan[] = [];
  let pending: Promise<void> | undefined;
  let closed = false;

  async function sendBatch(spans: OtlpSpan[]): Promise<void> {
    if (!url || !spans.length) return;
    const serviceAttr = encodeAttribute('service.name', serviceName);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: requestHeaders,
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: { attributes: serviceAttr ? [serviceAttr] : [] },
              scopeSpans: [
                {
                  scope: { name: scopeName, version: scopeVersion },
                  spans,
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
    } catch {
    }
  }

  async function flush(): Promise<void> {
    if (pending) {
      await pending;
    }
    if (!url || !queue.length) return;
    while (queue.length > 0) {
      const spans = queue.splice(0);
      const current = sendBatch(spans);
      pending = current;
      try {
        await current;
      } finally {
        if (pending === current) pending = undefined;
      }
    }
  }

  const timer =
    url && flushIntervalMs > 0
      ? setInterval(() => void flush(), flushIntervalMs)
      : undefined;
  timer?.unref();

  function resolveParentContext(spanOptions: AgentSpanOptions): {
    traceId: string;
    parentSpanId?: string;
  } {
    if (spanOptions.parent) {
      return {
        traceId: spanOptions.parent.traceId.toLowerCase(),
        parentSpanId: spanOptions.parent.spanId.toLowerCase(),
      };
    }
    if (spanOptions.carrier) {
      const extracted = extractTraceparent(spanOptions.carrier);
      if (extracted) {
        return {
          traceId: extracted.traceId,
          parentSpanId: extracted.spanId,
        };
      }
    }
    const active = activeSpanStorage.getStore();
    if (active) {
      return {
        traceId: active.traceId,
        parentSpanId: active.spanId,
      };
    }
    return {
      traceId: randomBytes(16).toString('hex'),
    };
  }

  function startSpan(spanOptions: AgentSpanOptions): AgentSpanHandle {
    const { traceId, parentSpanId } = resolveParentContext(spanOptions);
    const spanId = randomBytes(8).toString('hex');
    const startEpochMs = Date.now();
    const startPerfMs = performance.now();
    const attributeMap = new Map<string, { raw: TraceAttributeValue; encoded: OtlpAttribute }>();
    const events: OtlpSpanEvent[] = [];
    let statusCode: 0 | 1 | 2 = 0;
    let statusMessage: string | undefined;
    let ended = false;

    function setAttr(key: string, value: TraceAttributeValue | undefined): void {
      if (ended || value === undefined) return;
      const encoded = encodeAttribute(key, value);
      if (encoded) {
        attributeMap.set(key, { raw: value, encoded });
      }
    }

    setAttr('gen_ai.operation.name', spanOptions.operation);
    setAttr('gen_ai.system', spanOptions.system);
    setAttr('gen_ai.request.model', spanOptions.requestModel);
    setAttr('gen_ai.response.model', spanOptions.responseModel);
    setAttr('gen_ai.usage.input_tokens', spanOptions.inputTokens);
    setAttr('gen_ai.usage.output_tokens', spanOptions.outputTokens);
    setAttr('gen_ai.response.finish_reasons', spanOptions.finishReasons);
    setAttr('gen_ai.tool.name', spanOptions.toolName);
    setAttr('gen_ai.tool.call_id', spanOptions.toolCallId);
    setAttr('gen_ai.cost.dollars', spanOptions.costDollars);
    setAttr('agent.ttft_ms', spanOptions.ttftMs);
    setAttr('agent.otps', spanOptions.otps);

    if (spanOptions.attributes) {
      for (const [key, value] of Object.entries(spanOptions.attributes)) {
        setAttr(key, value);
      }
    }

    const handle: AgentSpanHandle = {
      traceId,
      spanId,
      parentSpanId,
      addEvent(name, attributes) {
        if (ended) return;
        const nowOffsetMs = Math.max(0, performance.now() - startPerfMs);
        const timeUnixNano =
          BigInt(startEpochMs) * 1_000_000n + BigInt(Math.round(nowOffsetMs * 1_000_000));
        events.push({
          timeUnixNano: String(timeUnixNano),
          name: scrubString(name),
          attributes: encodeAttributesRecord(attributes),
        });
      },
      setAttribute(key, value) {
        setAttr(key, value);
      },
      setStatus(status, message) {
        if (ended) return;
        if (status === 'error') {
          statusCode = 2;
          statusMessage = message !== undefined ? scrubString(message) : undefined;
        } else {
          statusCode = 1;
          statusMessage = undefined;
        }
      },
      end(endOptions?: AgentSpanEndOptions) {
        if (ended) return;

        if (endOptions?.responseModel !== undefined) {
          setAttr('gen_ai.response.model', endOptions.responseModel);
        }
        if (endOptions?.inputTokens !== undefined) {
          setAttr('gen_ai.usage.input_tokens', endOptions.inputTokens);
        }
        if (endOptions?.outputTokens !== undefined) {
          setAttr('gen_ai.usage.output_tokens', endOptions.outputTokens);
        }
        if (endOptions?.finishReasons !== undefined) {
          setAttr('gen_ai.response.finish_reasons', endOptions.finishReasons);
        }
        if (endOptions?.costDollars !== undefined) {
          setAttr('gen_ai.cost.dollars', endOptions.costDollars);
        }
        if (endOptions?.ttftMs !== undefined) {
          setAttr('agent.ttft_ms', endOptions.ttftMs);
        }
        if (endOptions?.otps !== undefined) {
          setAttr('agent.otps', endOptions.otps);
        }

        const measuredDurationMs = Math.max(
          0,
          Math.round((performance.now() - startPerfMs) * 100) / 100,
        );
        const existingDuration = attributeMap.get('agent.duration_ms')?.raw;
        const durationMs =
          endOptions?.durationMs !== undefined &&
          Number.isFinite(endOptions.durationMs) &&
          endOptions.durationMs >= 0
            ? endOptions.durationMs
            : spanOptions.durationMs !== undefined &&
                Number.isFinite(spanOptions.durationMs) &&
                spanOptions.durationMs >= 0
              ? spanOptions.durationMs
              : typeof existingDuration === 'number' &&
                  Number.isFinite(existingDuration) &&
                  existingDuration >= 0
                ? existingDuration
                : measuredDurationMs;
        setAttr('agent.duration_ms', durationMs);

        if (!attributeMap.has('agent.otps')) {
          const outputTokensRaw = attributeMap.get('gen_ai.usage.output_tokens')?.raw;
          const ttftRaw = attributeMap.get('agent.ttft_ms')?.raw;
          if (typeof outputTokensRaw === 'number' && outputTokensRaw > 0 && durationMs > 0) {
            const ttftMs =
              typeof ttftRaw === 'number' && Number.isFinite(ttftRaw) && ttftRaw >= 0 ? ttftRaw : 0;
            const generationMs = durationMs - Math.min(durationMs, ttftMs);
            if (generationMs > 0) {
              const otps = Math.round((outputTokensRaw / (generationMs / 1000)) * 100) / 100;
              setAttr('agent.otps', otps);
            }
          }
        }

        if (endOptions?.status === 'error' || endOptions?.error !== undefined) {
          statusCode = 2;
          const errorText =
            endOptions.error instanceof Error ? endOptions.error.message : endOptions.error;
          statusMessage = errorText !== undefined ? scrubString(errorText) : statusMessage;
        } else if (endOptions?.status === 'ok' && statusCode === 0) {
          statusCode = 1;
        }

        ended = true;
        if (closed || queue.length >= maxQueueSize) return;

        const startNs = BigInt(startEpochMs) * 1_000_000n;
        const endNs = startNs + BigInt(Math.max(0, Math.round(durationMs * 1_000_000)));
        const spanPayload: OtlpSpan = {
          traceId,
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name: scrubString(defaultSpanName(spanOptions)),
          kind: spanOptions.kind ?? defaultSpanKind(spanOptions.operation),
          startTimeUnixNano: String(startNs),
          endTimeUnixNano: String(endNs),
          attributes: Array.from(attributeMap.values(), (entry) => entry.encoded),
          events,
          status: statusMessage !== undefined ? { code: statusCode, message: statusMessage } : { code: statusCode },
        };
        queue.push(spanPayload);
      },
    };

    return handle;
  }

  async function withSpan<T>(
    spanOptions: AgentSpanOptions,
    fn: (span: AgentSpanHandle) => Promise<T> | T,
  ): Promise<T> {
    const span = startSpan(spanOptions);
    return activeSpanStorage.run(span, async () => {
      try {
        const result = await fn(span);
        span.end({ status: 'ok' });
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        span.addEvent('exception', {
          'exception.type': err.name,
          'exception.message': err.message,
        });
        span.end({ status: 'error', error: err });
        throw error;
      }
    });
  }

  return {
    startSpan,
    withSpan,
    injectTraceparent,
    extractTraceparent,
    addToolWarning,
    flush,
    async shutdown() {
      closed = true;
      if (timer) clearInterval(timer);
      await flush();
    },
  };
}
