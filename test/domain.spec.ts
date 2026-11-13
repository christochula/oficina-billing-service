import { authorize, makeBudget, requireApproved, validateEnvelope } from '../src/domain';
import { Order } from '../src/types';
import { orderInput, items, client, admin, mechanic, message } from './helpers';

describe('domain invariants', () => {
  const order: Order = { ...orderInput, status: 'AWAITING_BUDGET' };
  it('enforces role, ownership, tenant and mechanic assignment', () => {
    expect(() => authorize(order, client, 'read')).not.toThrow();
    expect(() => authorize(order, { sub: 'x', client_id: 'client-1', token_use: 'client' }, 'read')).not.toThrow();
    expect(() => authorize(order, { sub: 'x', clienteId: 'client-1', role: 'CLIENTE' }, 'checkout')).not.toThrow();
    expect(() => authorize(order, client, 'budget')).toThrow();
    expect(() => authorize(order, { ...client, filialId: 'other' }, 'read')).toThrow();
    expect(() => authorize(order, admin, 'decision')).toThrow();
    expect(() => authorize(order, { sub: 'x' }, 'read')).toThrow();
    expect(() => authorize(order, mechanic, 'budget')).not.toThrow();
    expect(() => authorize(order, mechanic, 'checkout')).toThrow();
    expect(() => authorize({ ...order, mecanicoId: undefined }, mechanic, 'budget')).toThrow();
  });
  it.each([null, [], new Array(101).fill(items[0]), [{}], [{ description: 'x', quantity: 0, unitPriceCents: 1 }], [{ description: 'x', quantity: 1.5, unitPriceCents: 1 }], [{ description: 'x', quantity: 1, unitPriceCents: -1 }], [{ description: 'x', quantity: 1, unitPriceCents: 0 }], [{ description: '', quantity: 1, unitPriceCents: 1 }], [{ description: 'x'.repeat(201), quantity: 1, unitPriceCents: 1 }], [{ description: 'x', quantity: 2, unitPriceCents: Number.MAX_SAFE_INTEGER }], [{ description: 'x', quantity: 1, unitPriceCents: 10, pecaId: 3 }]])('rejects invalid budget %j', input => { expect(() => makeBudget(input)).toThrow(); });
  it('accepts service-only item and requires customer approval', () => {
    expect(makeBudget([{ description: ' Test ', quantity: 1, unitPriceCents: 100 }])).toMatchObject({ totalCents: 100, version: 1, items: [{ description: 'Test' }] });
    expect(() => requireApproved(order)).toThrow();
    const budget = { ...makeBudget(items), approved: true };
    expect(requireApproved({ ...order, budget })).toBe(budget);
    expect(() => requireApproved({ ...order, budget, status: 'REJECTED' })).toThrow();
  });
  it('validates minimum wire envelope', () => { expect(() => validateEnvelope(message('A'))).not.toThrow(); for (const input of [null, { ...message('A'), version: 2 }, { ...message('A'), payload: null }, { ...message('A'), osId: 3 }]) expect(() => validateEnvelope(input)).toThrow(); });
  it('keeps groups, notes and part snapshots while retaining the original array contract', () => {
    const material = { ...items[0], nome: 'Filtro', codigo: 'F-01', filialId: 'branch-1' };
    const labor = { description: 'Mão de obra', quantity: 1, unitPriceCents: 1500 };
    const groups = [{ title: 'Peças', items: [material] }, { title: 'Serviços', items: [labor] }];
    const result = makeBudget({ groups, items: [material, labor], notasCliente: 'Prazo combinado', notasInternas: 'Inspeção extra' }, makeBudget(items));
    expect(result).toMatchObject({ groups, items: [material, labor], totalCents: 6500, version: 2, notasCliente: 'Prazo combinado', notasInternas: 'Inspeção extra' });
    expect(makeBudget(items)).toMatchObject({ totalCents: 5000, version: 1 });
  });
  it.each([
    { groups: [] },
    { groups: [{ title: '', items }] },
    { groups: [{ title: 'Peças', items: [] }] },
    { groups: [{ title: 'Peças', items }], items: [{ ...items[0], quantity: 3 }] },
    { items, notasCliente: 'x'.repeat(1001) },
    { items, notasInternas: 3 },
    { items: [{ ...items[0], codigo: 3 }] },
  ])('rejects inconsistent grouped or annotated budget %j', input => expect(() => makeBudget(input)).toThrow());
});
