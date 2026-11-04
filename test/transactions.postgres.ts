import { Pool } from 'pg';
import { PostgresStore } from '../src/store';
import { context, orderInput } from './helpers';
describe('Real PostgreSQL transactions', () => {
  const store = new PostgresStore(new Pool({ connectionString: process.env.TEST_DATABASE_URL }));
  beforeAll(async () => { if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL obrigatoria; este teste nunca e pulado'); await store.initialize(); });
  beforeEach(async () => { await store.pool.query('TRUNCATE billing_orders,billing_inbox,billing_outbox'); await store.create({ ...orderInput, status: 'AWAITING_BUDGET' }); });
  afterAll(async () => { await store.close(); });
  it('rolls back order, inbox and event atomically on failure', async () => {
    await expect(store.change('os-1', context, ({ order, emit }) => { order.status = 'APPROVED'; emit('BudgetApproved'); throw new Error('interrupted'); }, 'msg')).rejects.toThrow('interrupted');
    expect((await store.get('os-1')).status).toBe('AWAITING_BUDGET'); expect((await store.pool.query('SELECT * FROM billing_inbox')).rows).toHaveLength(0); expect((await store.pool.query('SELECT * FROM billing_outbox')).rows).toHaveLength(0);
  });
  it('commits once for concurrent duplicate deliveries and delivers persistent event', async () => {
    const apply = () => store.change('os-1', context, ({ order, emit }) => { order.status = 'APPROVED'; emit('BudgetApproved'); }, 'msg');
    await Promise.all([apply(), apply()]); expect((await store.pool.query('SELECT * FROM billing_outbox')).rows).toHaveLength(1);
    await store.deliverOutbox(async () => { throw new Error('SQS temporarily unavailable'); });
    expect((await store.pool.query('SELECT attempts,delivered_at FROM billing_outbox')).rows[0]).toMatchObject({ attempts: 1, delivered_at: null });
    await store.pool.query("UPDATE billing_outbox SET next_attempt_at=now()-interval '1 second'"); const send = jest.fn().mockResolvedValue(undefined); await store.deliverOutbox(send); await store.deliverOutbox(send); expect(send).toHaveBeenCalledTimes(1);
  });
});
