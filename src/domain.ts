import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Budget, BudgetItem, Claims, Order } from './types';

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

export function makeBudget(items: unknown, previous?: Budget): Budget {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw new BadRequestException('Informe 1 a 100 itens');
  const checked: BudgetItem[] = items.map((input: BudgetItem) => {
    if (!input || typeof input.description !== 'string' || !input.description.trim() || input.description.length > 200 || !Number.isSafeInteger(input.quantity) || input.quantity <= 0 || !Number.isSafeInteger(input.unitPriceCents) || input.unitPriceCents < 0 || (input.pecaId !== undefined && typeof input.pecaId !== 'string')) throw new BadRequestException('Item invalido: quantidade inteira positiva e valor em centavos');
    return { description: input.description.trim(), quantity: input.quantity, unitPriceCents: input.unitPriceCents, ...(input.pecaId ? { pecaId: input.pecaId } : {}) };
  });
  const totalCents = checked.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new BadRequestException('Total deve ser positivo e inteiro seguro');
  return { items: checked, totalCents, version: (previous?.version ?? 0) + 1, approved: false, frozen: false };
}

export function requireApproved(order: Order): Budget {
  if (!order.budget?.approved || order.status === 'REJECTED') throw new ConflictException('Orcamento nao aprovado');
  return order.budget;
}

export function validateEnvelope(input: unknown): asserts input is import('./types').Envelope {
  const msg = input as import('./types').Envelope;
  if (!msg || msg.version !== 1 || !['messageId', 'type', 'sagaId', 'osId', 'filialId', 'correlationId', 'occurredAt'].every(key => typeof (msg as unknown as Record<string, unknown>)[key] === 'string' && String((msg as unknown as Record<string, unknown>)[key]).length > 0) || !msg.payload || typeof msg.payload !== 'object') throw new BadRequestException('Envelope invalido');
}
