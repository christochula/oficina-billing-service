import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Budget, BudgetGroup, BudgetItem, Claims, Order } from './types';

export function authorize(order: Order, claims: Claims, action: 'read' | 'budget' | 'decision' | 'checkout'): void {
  const role = claims.role ?? claims.papel;
  if (claims.filialId && claims.filialId !== order.filialId) throw new ForbiddenException('Filial diferente');
  if (role === 'CLIENTE' || claims.token_use === 'client') {
    if ((claims.client_id ?? claims.clienteId ?? claims.sub) !== order.clienteId || action === 'budget') throw new ForbiddenException('Acesso negado');
    return;
  }
  if (action === 'decision' || !['ADMINISTRADOR', 'CONSULTOR_TECNICO', 'MECANICO'].includes(role ?? '')) throw new ForbiddenException('Papel sem permissao');
  if (role === 'MECANICO' && (action === 'checkout' || order.mecanicoId !== claims.sub)) throw new ForbiddenException('Acesso negado');
}

function checkedItems(items: unknown): BudgetItem[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw new BadRequestException('Informe 1 a 100 itens');
  return items.map((input: BudgetItem) => {
    if (!input || typeof input.description !== 'string' || !input.description.trim() || input.description.length > 200 || !Number.isSafeInteger(input.quantity) || input.quantity <= 0 || !Number.isSafeInteger(input.unitPriceCents) || input.unitPriceCents < 0 || (input.pecaId !== undefined && typeof input.pecaId !== 'string')) throw new BadRequestException('Item invalido: quantidade inteira positiva e valor em centavos');
    const identity: Partial<BudgetItem> = {};
    for (const key of ['codigo', 'nome', 'filialId'] as const) {
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'string' || input[key]!.length > 200) throw new BadRequestException('Identificação de peça inválida');
        identity[key] = input[key];
      }
    }
    return { description: input.description.trim(), quantity: input.quantity, unitPriceCents: input.unitPriceCents, ...(input.pecaId ? { pecaId: input.pecaId, ...identity } : {}) };
  });
}

export function makeBudget(input: unknown, previous?: Budget): Budget {
  // The array format remains valid for existing integrations and stored events.
  const value = (Array.isArray(input) ? { items: input } : input) as { items?: unknown; groups?: unknown; notasCliente?: unknown; notasInternas?: unknown } | null;
  if (!value || typeof value !== 'object') throw new BadRequestException('Orçamento inválido');
  let groups: BudgetGroup[] | undefined;
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups) || !value.groups.length || value.groups.length > 100) throw new BadRequestException('Grupos inválidos');
    groups = value.groups.map(group => {
      if (!group || typeof group.title !== 'string' || !group.title.trim() || group.title.length > 120) throw new BadRequestException('Título de grupo inválido');
      return { title: group.title, items: checkedItems(group.items) };
    });
  }
  const checked = groups ? checkedItems(groups.flatMap(group => group.items)) : checkedItems(value.items);
  if (groups && value.items !== undefined && JSON.stringify(checkedItems(value.items)) !== JSON.stringify(checked)) throw new BadRequestException('Itens e grupos divergentes');
  const notes: Pick<Budget, 'notasCliente' | 'notasInternas'> = {};
  for (const key of ['notasCliente', 'notasInternas'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || value[key].length > 1000) throw new BadRequestException('Nota do orçamento inválida');
      notes[key] = value[key];
    }
  }
  const totalCents = checked.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new BadRequestException('Total deve ser positivo e inteiro seguro');
  return { items: checked, ...(groups ? { groups } : {}), ...notes, totalCents, version: (previous?.version ?? 0) + 1, approved: false, frozen: false };
}

export function requireApproved(order: Order): Budget {
  if (!order.budget?.approved || order.status === 'REJECTED') throw new ConflictException('Orcamento nao aprovado');
  return order.budget;
}

export function validateEnvelope(input: unknown): asserts input is import('./types').Envelope {
  const msg = input as import('./types').Envelope;
  if (!msg || msg.version !== 1 || !['messageId', 'type', 'sagaId', 'osId', 'filialId', 'correlationId', 'occurredAt'].every(key => typeof (msg as unknown as Record<string, unknown>)[key] === 'string' && String((msg as unknown as Record<string, unknown>)[key]).length > 0) || !msg.payload || typeof msg.payload !== 'object') throw new BadRequestException('Envelope invalido');
}
