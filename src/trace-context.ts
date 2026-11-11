import tracer from 'dd-trace';
import { RequestHandler } from 'express';

type Headers = Record<string, string | string[] | undefined>;
type Tracing = Pick<typeof tracer, 'scope' | 'inject'>;

export function validTraceparent(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  return Boolean(match && match[1] !== 'ff' && match[2] !== '0'.repeat(32) && match[3] !== '0'.repeat(16));
}

/** Persist the current local span, retaining an incoming parent only as fallback. */
export function captureTraceparent(incoming?: string, tracing: Tracing = tracer): string | undefined {
  try {
    const active = tracing.scope().active();
    if (active) {
      const carrier: Record<string, string> = {};
      tracing.inject(active.context(), 'http_headers', carrier);
      if (validTraceparent(carrier.traceparent)) return carrier.traceparent;
    }
  } catch { /* Telemetry must not interrupt durable work. */ }
  return validTraceparent(incoming) ? incoming : undefined;
}

interface TraceableMessage {
  messageId: string; type: string; osId: string; sagaId: string; correlationId: string; traceparent?: string;
}

export async function traceOutbox<T extends TraceableMessage>(name: string, message: T, publish: (outgoing: T) => Promise<void>): Promise<void> {
  let parent: ReturnType<typeof tracer.extract> = null;
  try { if (message.traceparent) parent = tracer.extract('http_headers', { traceparent: message.traceparent }); }
  catch { /* Missing trace context must not discard durable work. */ }
  await tracer.trace(name, { childOf: parent || undefined, resource: message.type, tags: {
    'span.kind': 'producer', 'messaging.system': 'aws_sqs', 'messaging.message_id': message.messageId,
    'message.type': message.type, 'saga.id': message.sagaId, 'os.id': message.osId, 'correlation.id': message.correlationId,
  } }, async () => publish({ ...message, traceparent: captureTraceparent(message.traceparent) }));
}

export function withTraceIds(record: Record<string, unknown>): Record<string, unknown> {
  try { const active = tracer.scope().active(); if (active) tracer.inject(active.context(), 'log', record); }
  catch { /* Logging remains available with tracing disabled. */ }
  return record;
}

/** Bridge the HTTP span created by dd-trace into the durable outbox context. */
export function hydrateTraceparent(headers: Headers, tracing: Tracing = tracer): void {
  if (validTraceparent(headers.traceparent)) return;
  delete headers.traceparent;
  try {
    const active = tracing.scope().active();
    if (!active) return;
    const carrier: Record<string, string> = {};
    tracing.inject(active.context(), 'http_headers', carrier);
    if (validTraceparent(carrier.traceparent)) headers.traceparent = carrier.traceparent;
  } catch { /* Disabled or unavailable tracing must not interrupt an HTTP request. */ }
}

export function traceContextMiddleware(tracing: Tracing = tracer): RequestHandler {
  return (req, _res, next) => { hydrateTraceparent(req.headers, tracing); next(); };
}
