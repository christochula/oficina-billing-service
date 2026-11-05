import tracer from 'dd-trace';
import { RequestHandler } from 'express';

type Headers = Record<string, string | string[] | undefined>;
type Tracing = Pick<typeof tracer, 'scope' | 'inject'>;

export function validTraceparent(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  return Boolean(match && match[1] !== 'ff' && match[2] !== '0'.repeat(32) && match[3] !== '0'.repeat(16));
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
