import { hydrateTraceparent, validTraceparent } from '../src/trace-context';

const traceparent = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
describe('HTTP to outbox W3C context bridge', () => {
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
