import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { sign } from 'jsonwebtoken';
import { createHmac } from 'node:crypto';
import { BillingController, InternalController, HealthController, WebhookController, BillingHealthController } from '../src/controller';
import { BillingService } from '../src/billing';
import { MemoryStore, orderInput, items } from './helpers';
import { traceContextMiddleware } from '../src/trace-context';

describe('HTTP boundary integration', () => {
  let app: INestApplication; let billing: BillingService;
  const jwt = (sub: string, role: string) => sign({ sub, role }, 'secret', { issuer: 'oficina-auth-serverless', audience: 'oficina-api', expiresIn: 300 });
  const provider = { create: jest.fn(), findPreference: jest.fn(), findPayments: jest.fn(), getPayment: jest.fn() };
  beforeEach(async () => {
    process.env.JWT_SECRET = 'secret'; process.env.AUTH_CLIENT_LOOKUP_TOKEN = 'internal'; process.env.MP_WEBHOOK_SECRET = 'webhook';
    billing = new BillingService(new MemoryStore(), provider);
    const module = await Test.createTestingModule({ controllers: [BillingController, InternalController, HealthController, WebhookController, BillingHealthController], providers: [{ provide: BillingService, useValue: billing }] }).compile();
    app = module.createNestApplication();
    app.use(traceContextMiddleware({
      scope: () => ({ active: () => ({ context: () => ({}) }) }),
      inject: (_context: unknown, _format: unknown, carrier: Record<string, string>) => { carrier.traceparent = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01'; },
    } as never));
    await app.init();
  });
  afterEach(async () => { await app.close(); });
  it('requires internal token and JWT, exposes idempotent internal snapshot', async () => {
    await request(app.getHttpServer()).post('/api/v1/billing/internal/orders').send(orderInput).expect(401);
    await request(app.getHttpServer()).post('/api/v1/billing/internal/orders').set('X-Internal-Token', 'internal').send(orderInput).expect(201);
    const snap = await request(app.getHttpServer()).get('/api/v1/billing/internal/orders/os-1').set('X-Internal-Token', 'internal').expect(200); expect(snap.body.clienteId).toBe('client-1');
    await request(app.getHttpServer()).get('/api/v1/billing/orders/os-1').expect(401);
    await request(app.getHttpServer()).get('/api/v1/billing/orders/os-1').set('Authorization', `Bearer ${jwt('other', 'CLIENTE')}`).expect(403);
    await request(app.getHttpServer()).get('/api/health/live').expect(200); await request(app.getHttpServer()).get('/api/health/ready').expect(200); await request(app.getHttpServer()).get('/api/v1/billing/health').expect(200);
  });
  it('serves budget, approval, rejection, payment and checkout routes', async () => {
    await billing.create(orderInput); const mechanic = `Bearer ${jwt('mechanic-1', 'MECANICO')}`; const customer = `Bearer ${jwt('client-1', 'CLIENTE')}`;
    await request(app.getHttpServer()).put('/api/v1/billing/orders/os-1/budget').set('Authorization', mechanic).set('X-Correlation-Id', 'corr').set('traceparent', '00-trace').send({ items }).expect(200);
    await request(app.getHttpServer()).post('/api/v1/billing/orders/os-1/approve').set('Authorization', customer).expect(201);
    const result = await request(app.getHttpServer()).get('/api/v1/billing/orders/os-1').set('Authorization', customer).expect(200); expect(result.body.budget.totalCents).toBe(5000);
    const payment = await request(app.getHttpServer()).get('/api/v1/billing/orders/os-1/payment').set('Authorization', customer).expect(200); expect(payment.body.status).toBe('NOT_CREATED');
    await request(app.getHttpServer()).post('/api/v1/billing/orders/os-1/checkout').set('Authorization', customer).expect(409);
    await billing.create({ ...orderInput, osId: 'os-2' });
    await request(app.getHttpServer()).put('/api/v1/billing/orders/os-2/budget').set('Authorization', mechanic).send({ items }).expect(200);
    await request(app.getHttpServer()).post('/api/v1/billing/orders/os-2/reject').set('Authorization', customer).expect(201);
  });
  it('authenticates webhook signature before contacting provider', async () => {
    await request(app.getHttpServer()).post('/api/v1/billing/webhooks/mercadopago?data.id=123').expect(401);
    const stamp = String(Math.floor(Date.now() / 1000)); const sig = createHmac('sha256', 'webhook').update(`id:123;request-id:req;ts:${stamp};`).digest('hex');
    const spy = jest.spyOn(billing, 'webhook').mockResolvedValue();
    await request(app.getHttpServer()).post('/api/v1/billing/webhooks/mercadopago?data.id=123').set('x-request-id', 'req').set('x-signature', `ts=${stamp},v1=${sig}`).expect(201); expect(spy).toHaveBeenCalledWith('123');
  });
  it('persists W3C context in the generated event for browser requests without headers', async () => {
    await billing.create(orderInput);
    await request(app.getHttpServer()).put('/api/v1/billing/orders/os-1/budget')
      .set('Authorization', `Bearer ${jwt('mechanic-1', 'MECANICO')}`).send({ items }).expect(200);
    const store = billing.store as MemoryStore;
    expect(store.events.find(event => event.type === 'BudgetGenerated')?.traceparent)
      .toBe('00-1234567890abcdef1234567890abcdef-1234567890abcdef-01');
  });
});
