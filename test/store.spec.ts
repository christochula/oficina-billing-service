import { newDb, DataType } from 'pg-mem';
import { Pool } from 'pg';
import { PostgresStore } from '../src/store';
import { context, orderInput } from './helpers';

describe('Postgres store SQL persistence', () => {
  let store: PostgresStore;
  beforeEach(async () => { const db = newDb(); db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 }); const pg = db.adapters.createPg(); store = new PostgresStore(new pg.Pool() as unknown as Pool); await store.initialize(); });
  afterEach(async () => { await store.close(); });
  it('creates idempotently, rejects conflicting owners and reads persisted documents', async () => {
    await store.health(); expect((await store.create({ ...orderInput, status: 'AWAITING_BUDGET' })).osId).toBe('os-1');
    await store.create({ ...orderInput, status: 'PAID' }); expect((await store.get('os-1')).status).toBe('AWAITING_BUDGET');
    await expect(store.create({ ...orderInput, filialId: 'other', status: 'PAID' })).rejects.toThrow();
    await expect(store.get('missing')).rejects.toThrow();
  });
  it('saves order, inbox and outbox together, skips duplicate message', async () => {
    await store.create({ ...orderInput, status: 'AWAITING_BUDGET' });
    await store.change('os-1', { ...context, traceparent: 'trace' }, ({ order, emit }) => { order.status = 'APPROVED'; emit('BudgetPrepared', { totalCents: 100 }); emit('Audit'); return 123; }, 'm1');
    expect((await store.get('os-1')).status).toBe('APPROVED');
    expect((await store.pool.query('SELECT * FROM billing_outbox')).rows).toHaveLength(2);
    const callback = jest.fn(); await store.change('os-1', context, callback, 'm1'); expect(callback).not.toHaveBeenCalled();
    await expect(store.change('missing', context, () => {})).rejects.toThrow();
    await expect(store.change('os-1', context, () => { throw new Error('abort'); })).rejects.toThrow('abort');
  });
  it('queries unsettled payment orders only', async () => {
    await store.create({ ...orderInput, status: 'AWAITING_BUDGET' });
    expect(await store.pendingPayments()).toHaveLength(0);
    await store.change('os-1', context, ({ order }) => { order.payment = { status: 'UNKNOWN', key: 'k', externalReference: 'r', amountCents: 1 }; });
    expect(await store.pendingPayments()).toHaveLength(1);
    await store.change('os-1', context, ({ order }) => { order.payment!.status = 'REJECTED'; });
    expect(await store.pendingPayments()).toHaveLength(1);
    await store.change('os-1', context, ({ order }) => { order.payment!.status = 'APPROVED'; });
    expect(await store.pendingPayments()).toHaveLength(0);
  });
});

describe('Outbox delivery transaction', () => {
  function setup(fail = false) {
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT')) return { rows: [{ id: 'event', body: { type: 'BudgetApproved', correlationId: 'c' } }], rowCount: 1 };
      if (fail && sql.startsWith('UPDATE')) throw new Error('DB unavailable');
      return { rows: [], rowCount: 1 };
    });
    const release = jest.fn(); const store = new PostgresStore({ connect: async () => ({ query, release }) } as never); return { query, release, store };
  }
  it('marks delivery only after acknowledgement and retains failures for retry', async () => {
    const success = setup(); const send = jest.fn().mockResolvedValue(undefined); await success.store.deliverOutbox(send);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'BudgetApproved' })); expect(success.query.mock.calls.some(call => call[0].includes('delivered_at=now'))).toBe(true); expect(success.release).toHaveBeenCalled();
    const failure = setup(); await failure.store.deliverOutbox(jest.fn().mockRejectedValue(new Error('SQS down')));
    expect(failure.query.mock.calls.some(call => call[0].includes('attempts=attempts+1'))).toBe(true);
  });
  it('rolls back and releases connection when database write fails', async () => {
    const { store, query, release } = setup(true); await expect(store.deliverOutbox(async () => {})).rejects.toThrow();
    expect(query).toHaveBeenCalledWith('ROLLBACK'); expect(release).toHaveBeenCalled();
  });
});
