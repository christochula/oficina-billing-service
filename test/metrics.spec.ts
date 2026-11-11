import { RequestMetrics } from '../src/metrics';
describe('Datadog shared metric contract', () => {
  function socket() { return { send: jest.fn((_body, _port, _host, callback) => callback()), unref: jest.fn(), on: jest.fn(), close: jest.fn() }; }
  it('emits a distribution in milliseconds with bounded HTTP and service tags', () => {
    const udp = socket(); const metrics = new RequestMetrics({ DD_METRICS_ENABLED: 'true', DD_SERVICE: 'oficina-billing-service', DD_ENV: 'homolog', DD_VERSION: 'sha', DD_AGENT_HOST: 'agent', DD_DOGSTATSD_PORT: '8126' }, () => udp as never);
    metrics.observe(12.3456, 'GET', 200); expect(udp.send.mock.calls[0][0].toString()).toBe('oficina.api.request.duration_ms:12.346|d|#method:GET,status_code:200,service:oficina-billing-service,env:homolog,version:sha'); expect(udp.send.mock.calls[0].slice(1, 3)).toEqual([8126, 'agent']);
    expect(udp.unref).toHaveBeenCalled(); expect(udp.on).toHaveBeenCalledWith('error', expect.any(Function)); udp.on.mock.calls[0][1](); metrics.close(); expect(udp.close).toHaveBeenCalled();
  });
  it('disables metrics for tests, supplies defaults and tolerates invalid samples/socket errors', () => {
    const factory = jest.fn(); const disabled = new RequestMetrics({ DD_METRICS_ENABLED: 'false' }, factory); disabled.observe(1, 'GET', 200); disabled.close(); expect(factory).not.toHaveBeenCalled();
    const udp = socket(); const metrics = new RequestMetrics({ DD_METRICS_ENABLED: 'true' }, () => udp as never);
    metrics.observe(NaN, 'GET', 200); metrics.observe(-1, 'GET', 200); expect(udp.send).not.toHaveBeenCalled();
    metrics.observe(2, 'POST', 500); expect(udp.send.mock.calls[0][0].toString()).toContain('service:oficina-billing-service,env:homolog,version:4.0.0');
    udp.send.mockImplementationOnce(() => { throw new Error('network'); }); expect(() => metrics.observe(3, 'GET', 200)).not.toThrow();
  });
  it('emits processed/failed count metrics without message or customer IDs as tags', () => {
    const udp = socket(); const metrics = new RequestMetrics({ DD_METRICS_ENABLED: 'true' }, () => udp as never);
    metrics.messageProcessed(); metrics.messageProcessed(true);
    expect(udp.send.mock.calls[0][0].toString()).toBe('oficina.messaging.processed:1|c|#queue:billing-commands,service:oficina-billing-service,env:homolog,version:4.0.0');
    expect(udp.send.mock.calls[1][0].toString()).toContain('oficina.messaging.failed:1|c|#queue:billing-commands');
    metrics.close();
  });
});
