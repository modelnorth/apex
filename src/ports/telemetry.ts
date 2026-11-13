export type GenAiOperationName = 'chat' | 'execute_tool' | 'session' | 'subagent';

export type TraceAttributeValue = string | number | boolean | readonly string[];

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags?: string;
}

export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
  [key: string]: string | undefined;
}

export interface AgentSpanOptions {
  name?: string;
  operation: GenAiOperationName;
  parent?: AgentSpanHandle | TraceContext;
  carrier?: TraceCarrier;
  system?: string;
  requestModel?: string;
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  finishReasons?: readonly string[];
  toolName?: string;
  toolCallId?: string;
  costDollars?: number;
  ttftMs?: number;
  otps?: number;
  durationMs?: number;
  kind?: number;
  attributes?: Record<string, TraceAttributeValue | undefined>;
}

export interface AgentSpanEndOptions {
  status?: 'ok' | 'error';
  error?: string | Error;
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  finishReasons?: readonly string[];
  costDollars?: number;
  ttftMs?: number;
  otps?: number;
  durationMs?: number;
}

export interface AgentSpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  addEvent(name: string, attributes?: Record<string, TraceAttributeValue | undefined>): void;
  setAttribute(key: string, value: TraceAttributeValue | undefined): void;
  setStatus?(status: 'ok' | 'error', message?: string): void;
  end(options?: AgentSpanEndOptions): void;
}

export interface AgentTracer {
  startSpan(options: AgentSpanOptions): AgentSpanHandle;
  withSpan<T>(
    options: AgentSpanOptions,
    fn: (span: AgentSpanHandle) => Promise<T> | T,
  ): Promise<T>;
  injectTraceparent(ctx: TraceContext | AgentSpanHandle): TraceCarrier;
  extractTraceparent(carrier: TraceCarrier): TraceContext | undefined;
  addToolWarning(
    span: AgentSpanHandle,
    message: string,
    attributes?: Record<string, TraceAttributeValue | undefined>,
  ): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}
