import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { BillingStore, Context, Envelope, Order, Transaction } from './types';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_orders (os_id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS billing_inbox (message_id text PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS billing_outbox (id text PRIMARY KEY, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS billing_outbox_pending ON billing_outbox(next_attempt_at) WHERE delivered_at IS NULL;
`;

export class PostgresStore implements BillingStore {
  constructor(readonly pool: Pool) {}
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(44114)');
      await client.query(SCHEMA); await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
  async health(): Promise<void> { await this.pool.query('SELECT 1'); }
  async create(order: Order): Promise<Order> {
    await this.pool.query('INSERT INTO billing_orders(os_id,data) VALUES($1,$2) ON CONFLICT(os_id) DO NOTHING', [order.osId, order]);
    const existing = await this.get(order.osId);
    if (existing.clienteId !== order.clienteId || existing.filialId !== order.filialId) throw new ConflictException('OS existente com outros dados');
    return existing;
  }
  async get(osId: string): Promise<Order> {
    const result = await this.pool.query('SELECT data FROM billing_orders WHERE os_id=$1', [osId]);
    if (!result.rows[0]) throw new NotFoundException('OS nao encontrada no Billing');
    return result.rows[0].data as Order;
  }
  async change<T>(osId: string, context: Context, callback: (tx: Transaction) => T | Promise<T>, messageId?: string): Promise<T | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (messageId) {
        const receipt = await client.query('INSERT INTO billing_inbox(message_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING message_id', [messageId]);
        if (!receipt.rowCount) { await client.query('COMMIT'); return undefined; }
      }
      const result = await client.query('SELECT data FROM billing_orders WHERE os_id=$1 FOR UPDATE', [osId]);
      if (!result.rows[0]) throw new NotFoundException('OS nao encontrada no Billing');
      const order = result.rows[0].data as Order;
      const events: Envelope[] = [];
      const value = await callback({ order, emit: (type, payload = {}) => events.push({ messageId: randomUUID(), type, version: 1, sagaId: context.sagaId, osId, filialId: order.filialId, correlationId: context.correlationId, occurredAt: new Date().toISOString(), ...(context.traceparent ? { traceparent: context.traceparent } : {}), payload }) });
      await client.query('UPDATE billing_orders SET data=$2 WHERE os_id=$1', [osId, order]);
      for (const event of events) await client.query('INSERT INTO billing_outbox(id,body) VALUES($1,$2)', [event.messageId, event]);
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async pendingPayments(): Promise<Order[]> {
    const result = await this.pool.query("SELECT data FROM billing_orders WHERE data->'payment'->>'status' IN ('CREATING','UNKNOWN','PENDING','REJECTED') LIMIT 50");
    return result.rows.map(row => row.data as Order);
  }
  async deliverOutbox(send: (body: Envelope) => Promise<void>): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT id,body FROM billing_outbox WHERE delivered_at IS NULL AND next_attempt_at <= now() ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED');
      for (const row of result.rows) {
        try { await send(row.body as Envelope); await client.query('UPDATE billing_outbox SET delivered_at=now() WHERE id=$1', [row.id]); }
        catch { await client.query("UPDATE billing_outbox SET attempts=attempts+1,next_attempt_at=now()+interval '10 seconds' WHERE id=$1", [row.id]); }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
