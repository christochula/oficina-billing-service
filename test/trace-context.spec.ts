import tracer from 'dd-trace';
import { captureTraceparent, hydrateTraceparent, traceOutbox, validTraceparent, withTraceIds } from '../src/trace-context';

const traceparent = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
describe('HTTP to outbox W3C context bridge', () => {
  afterEach(() => jest.restoreAllMocks());
  const context = {};
  function tracing(value: string | undefined = traceparent) {
    return {
      scope: () => ({ active: () => ({ context: () => context }) }),
      inject: jest.fn((_ctx, _format, carrier) => { if (value) carrier.traceparent = value; }),
    };
  }
  it('injects active HTTP span when the browser supplies no trace header', () => {
    const headers: Record<string, string> = {}; const active = tracing();
    hydrateTraceparent(headers, active as never);
    expect(headers.traceparent).toBe(traceparent);
    expect(active.inject).toHaveBeenCalledWith(context, 'http_headers', expect.any(Object));
  });
  it('preserves valid incoming context without replacing it with the local span', () => {
    const headers = { traceparent }; const active = tracing();
    hydrateTraceparent(headers, active as never);
    expect(headers.traceparent).toBe(traceparent); expect(active.inject).not.toHaveBeenCalled();
  });
  it('persists the local child span rather than its valid incoming parent', () => {
    const incoming = '00-1234567890abcdef1234567890abcdef-1111111111111111-01';
    expect(captureTraceparent(incoming, tracing() as never)).toBe(traceparent);
    expect(captureTraceparent(incoming, { scope: () => ({ active: () => null }) } as never)).toBe(incoming);
    expect(captureTraceparent('invalid', { scope: () => { throw new Error('disabled'); } } as never)).toBeUndefined();
  });
  it('restores delayed publishing under the durable parent without mutating/repeating its message', async () => {
    const parent = {} as NonNullable<ReturnType<typeof tracer.extract>>;
    const extract = jest.spyOn(tracer, 'extract').mockReturnValue(parent);
    const local = tracing();
    jest.spyOn(tracer, 'scope').mockImplementation(local.scope as never);
    jest.spyOn(tracer, 'inject').mockImplementation(local.inject as never);
    const trace = jest.spyOn(tracer, 'trace').mockImplementation(((_name: string, _options: unknown, run: () => Promise<void>) => run()) as typeof tracer.trace);
    const incoming = '00-1234567890abcdef1234567890abcdef-1111111111111111-01';
    const message = { messageId: 'message', type: 'BudgetPrepared', sagaId: 'saga', osId: 'os', correlationId: 'corr', traceparent: incoming, payload: { amountCents: 100 } };
    const send = jest.fn().mockResolvedValue(undefined);
    await traceOutbox('billing.outbox.publish', message, send);
    expect(extract).toHaveBeenCalledWith('http_headers', { traceparent: incoming });
    expect(trace).toHaveBeenCalledWith('billing.outbox.publish', expect.objectContaining({ childOf: parent, resource: 'BudgetPrepared' }), expect.any(Function));
    expect(send).toHaveBeenCalledWith({ ...message, traceparent });
    expect(message.traceparent).toBe(incoming);
    extract.mockImplementationOnce(() => { throw new Error('disabled'); });
    send.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(traceOutbox('billing.outbox.publish', message, send)).rejects.toThrow('queue unavailable');
    expect(send).toHaveBeenCalledTimes(2);
    expect(withTraceIds({ event: 'published' })).toHaveProperty('event', 'published');
    jest.spyOn(tracer, 'scope').mockImplementation(() => { throw new Error('disabled'); });
    expect(withTraceIds({ event: 'published' })).toEqual({ event: 'published' });
  });
  it('replaces invalid incoming context and tolerates disabled/non-W3C tracing', () => {
    const headers: Record<string, string> = { traceparent: 'invalid' };
    hydrateTraceparent(headers, tracing() as never); expect(headers.traceparent).toBe(traceparent);
    const empty: Record<string, string> = {};
    hydrateTraceparent(empty, { scope: () => ({ active: () => null }) } as never); expect(empty.traceparent).toBeUndefined();
    hydrateTraceparent(empty, tracing('not-w3c') as never); expect(empty.traceparent).toBeUndefined();
    hydrateTraceparent(empty, { scope: () => { throw new Error('disabled'); } } as never); expect(empty.traceparent).toBeUndefined();
  });
  it.each([null, [], 'ff-1234567890abcdef1234567890abcdef-1234567890abcdef-01', '00-00000000000000000000000000000000-1234567890abcdef-01', '00-1234567890abcdef1234567890abcdef-0000000000000000-01'])('rejects invalid W3C identity %j', value => { expect(validTraceparent(value)).toBe(false); });
});
