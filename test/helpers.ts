import { BillingStore, Context, Envelope, Order, Transaction } from '../src/types';
import { NotFoundException, ConflictException } from '@nestjs/common';

export class MemoryStore implements BillingStore {
  orders = new Map<string, Order>(); events: Partial<Envelope>[] = []; inbox = new Set<string>();
  async initialize() {} async close() {} async health() {}
  async create(order: Order) { const previous = this.orders.get(order.osId); if (previous && (previous.clienteId !== order.clienteId || previous.filialId !== order.filialId)) throw new ConflictException(); if (!previous) this.orders.set(order.osId, structuredClone(order)); return this.get(order.osId); }
  async get(id: string) { const order = this.orders.get(id); if (!order) throw new NotFoundException(); return structuredClone(order); }
  async change<T>(id: string, ctx: Context, fn: (tx: Transaction) => T | Promise<T>, messageId?: string) {
    if (messageId && this.inbox.has(messageId)) return undefined;
    const order = await this.get(id); const events: Partial<Envelope>[] = [];
    const value = await fn({ order, emit: (type, payload) => events.push({ type, payload, osId: id, ...ctx }) });
    this.orders.set(id, order); this.events.push(...events); if (messageId) this.inbox.add(messageId); return value;
  }
  async pendingPayments() { return [...this.orders.values()].filter(order => ['CREATING', 'UNKNOWN', 'PENDING', 'REJECTED'].includes(order.payment?.status ?? '')); }
}
export const orderInput = { osId: 'os-1', filialId: 'branch-1', clienteId: 'client-1', mecanicoId: 'mechanic-1' };
export const client = { sub: 'client-1', role: 'CLIENTE' };
export const mechanic = { sub: 'mechanic-1', papel: 'MECANICO' };
export const admin = { sub: 'admin', role: 'ADMINISTRADOR' };
export const context = { sagaId: 'saga-1', correlationId: 'correlation-1' };
export const items = [{ description: 'Reparo', quantity: 2, unitPriceCents: 2500, pecaId: 'part-1' }];
export function message(type: string, extra: Partial<Envelope> = {}): Envelope { return { messageId: `${type}-${Math.random()}`, type, version: 1, osId: 'os-1', filialId: 'branch-1', occurredAt: new Date().toISOString(), ...context, payload: {}, ...extra }; }
