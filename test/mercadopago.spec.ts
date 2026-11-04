import { MercadoPago, verifyWebhook } from '../src/mercadopago';
import { createHmac } from 'node:crypto';
import { Order, Payment } from '../src/types';
import { orderInput, items } from './helpers';
describe('Mercado Pago HTTP adapter', () => {
  const payment: Payment = { status: 'CREATING', key: 'key', externalReference: 'os-1:1', amountCents: 5000 };
  const order: Order = { ...orderInput, status: 'AWAITING_PAYMENT', budget: { items, totalCents: 5000, version: 1, approved: true, frozen: true } };
  const env = { MP_ACCESS_TOKEN: 'test', MP_NOTIFICATION_URL: 'https://hooks.example', MP_BACK_URL: 'https://app.example' };
  it('creates Checkout Pro preference in reais while preserving centavos internally', async () => {
    const http = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'p' }) });
    await new MercadoPago(env, http).create(order, payment);
    const [url, request] = http.mock.calls[0]; expect(url).toContain('/checkout/preferences');
    expect(JSON.parse(request.body)).toMatchObject({ external_reference: 'os-1:1', items: [{ unit_price: 50, quantity: 1, currency_id: 'BRL' }] });
    expect(request.headers['X-Idempotency-Key']).toBe('key');
  });
  it('handles search and authoritative lookup, refuses ambiguous preferences', async () => {
    const http = jest.fn(); const adapter = new MercadoPago(env, http);
    const reply = (value: unknown) => ({ ok: true, json: async () => value });
    http.mockResolvedValueOnce(reply({ elements: [] })); expect(await adapter.findPreference('os:1')).toBeUndefined();
    http.mockResolvedValueOnce(reply({ elements: [{ id: 'pref' }] })).mockResolvedValueOnce(reply({ id: 'pref', init_point: 'https://pay' })); expect((await adapter.findPreference('os:1'))?.id).toBe('pref');
    http.mockResolvedValueOnce(reply({ elements: [{ id: 'a' }, { id: 'b' }] })); await expect(adapter.findPreference('os:1')).rejects.toThrow('Mais de uma');
    http.mockResolvedValueOnce(reply({ results: [{ id: 1 }] })); expect(await adapter.findPayments('os:1')).toEqual([{ id: 1 }]);
    http.mockResolvedValueOnce(reply({ id: 1 })); expect(await adapter.getPayment('1')).toEqual({ id: 1 });
  });
  it('fails missing configuration, HTTP errors and insecure production endpoints', async () => {
    await expect(new MercadoPago({}).create(order, payment)).rejects.toThrow('URLs');
    await expect(new MercadoPago({}).getPayment('x')).rejects.toThrow('MP_ACCESS_TOKEN');
    await expect(new MercadoPago({ ...env, MP_API_BASE_URL: 'http://bad' }).getPayment('x')).rejects.toThrow('insegura');
    await expect(new MercadoPago(env, jest.fn().mockResolvedValue({ ok: false, status: 500 })).getPayment('1')).rejects.toThrow('500');
    const http = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 1 }) });
    await new MercadoPago({ ...env, NODE_ENV: 'test', MP_API_BASE_URL: 'http://mercadopago-stub:8000' }, http).getPayment('1'); expect(http).toHaveBeenCalled();
  });
});
describe('webhook authenticity', () => {
  const now = 1700000000000; const ts = '1700000000';
  const signature = createHmac('sha256', 'secret').update(`id:abc;request-id:request;ts:${ts};`).digest('hex');
  it('verifies constant-time HMAC and normalized id', () => { expect(() => verifyWebhook('ABC', 'request', `ts=${ts},v1=${signature}`, 'secret', now)).not.toThrow(); });
  it.each([[undefined, 'x'], ['request', undefined], ['request', `ts=${ts},v1=bad`], ['request', `ts=1,v1=${signature}`], ['request', `ts=${ts},v1=${'0'.repeat(64)}`]])('rejects invalid signature', (request, sig) => { expect(() => verifyWebhook('abc', request, sig, 'secret', now)).toThrow(); });
  it('rejects disabled secret and supports millisecond timestamps', () => {
    expect(() => verifyWebhook('abc', 'request', 'x', undefined)).toThrow();
    const stamp = String(now); const sig = createHmac('sha256', 'secret').update(`id:abc;request-id:request;ts:${stamp};`).digest('hex');
    expect(() => verifyWebhook('abc', 'request', `ts=${stamp},v1=${sig}`, 'secret', now)).not.toThrow();
  });
});
