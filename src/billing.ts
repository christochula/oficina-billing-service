import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { authorize, makeBudget, requireApproved, validateEnvelope } from './domain';
import { PaymentProvider, Preference, ProviderPayment } from './mercadopago';
import { BillingStore, Claims, Context, Envelope, Order, Payment } from './types';

export class BillingService {
  constructor(readonly store: BillingStore, readonly provider: PaymentProvider, readonly sandbox = true) {}
  async create(input: { osId: string; filialId: string; clienteId: string; mecanicoId?: string }): Promise<Order> {
    if (!input || !['osId', 'filialId', 'clienteId'].every(key => typeof (input as Record<string, unknown>)[key] === 'string' && String((input as Record<string, unknown>)[key]).length > 0)) throw new BadRequestException('Identificadores obrigatorios');
    return this.store.create({ osId: input.osId, filialId: input.filialId, clienteId: input.clienteId, ...(input.mecanicoId ? { mecanicoId: input.mecanicoId } : {}), status: 'AWAITING_BUDGET' });
  }
  async get(osId: string, claims?: Claims): Promise<Order> { const order = await this.store.get(osId); if (claims) authorize(order, claims, 'read'); return order; }
  async budget(osId: string, items: unknown, claims: Claims, ctx: Context): Promise<Order> {
    await this.store.change(osId, ctx, ({ order, emit }) => {
      authorize(order, claims, 'budget');
      if (order.budget?.approved || order.budget?.frozen || order.repairCompleted) throw new ConflictException('Orcamento aprovado ou congelado nao pode ser alterado');
      order.budget = makeBudget(items, order.budget); order.status = 'AWAITING_APPROVAL';
      emit('BudgetGenerated', { budget: order.budget });
    });
    return this.store.get(osId);
  }
  async decision(osId: string, approved: boolean, claims: Claims, ctx: Context): Promise<Order> {
    await this.store.change(osId, ctx, ({ order, emit }) => {
      authorize(order, claims, 'decision');
      if (approved && order.budget?.approved) return;
      if (!approved && order.status === 'REJECTED') return;
      if (!order.budget || order.status !== 'AWAITING_APPROVAL') throw new ConflictException('Orcamento nao aguarda decisao');
      order.budget.approved = approved; order.status = approved ? 'APPROVED' : 'REJECTED';
      emit(approved ? 'BudgetApproved' : 'BudgetRejected', { budget: order.budget });
    });
    return this.store.get(osId);
  }
  async command(input: unknown): Promise<void> {
    validateEnvelope(input); const msg = input;
    const ctx: Context = { sagaId: msg.sagaId, correlationId: msg.correlationId, ...(msg.traceparent ? { traceparent: msg.traceparent } : {}) };
    await this.store.change(msg.osId, ctx, ({ order, emit }) => {
      if (order.filialId !== msg.filialId) throw new ForbiddenException('Filial do comando divergente');
      try {
        switch (msg.type) {
          case 'AssignMechanic':
            if (typeof msg.payload.mecanicoId !== 'string' || !msg.payload.mecanicoId) throw new BadRequestException('mecanicoId obrigatorio');
            order.mecanicoId = msg.payload.mecanicoId; emit('MechanicLinked', { mecanicoId: order.mecanicoId }); break;
          case 'PrepareApprovedBudget': {
            const budget = requireApproved(order);
            if (order.releasedSagaIds?.includes(msg.sagaId)) throw new ConflictException('Saga compensada nao pode ser reaberta');
            if (order.preparedSagaId && order.preparedSagaId !== msg.sagaId) throw new ConflictException('Outra Saga possui o orcamento');
            budget.frozen = true; order.preparedSagaId = msg.sagaId; emit('BudgetPrepared', { budget }); break;
          }
          case 'ReleaseBudgetPreparation':
            if (order.repairCompleted) throw new ConflictException('Reparo realizado nao pode ser revertido');
            if (order.preparedSagaId && order.preparedSagaId !== msg.sagaId) throw new ConflictException('Saga divergente');
            if (order.budget) order.budget.frozen = false;
            order.releasedSagaIds = [...new Set([...(order.releasedSagaIds ?? []), msg.sagaId])];
            delete order.preparedSagaId; emit('BudgetReleased'); break;
          case 'CreatePayment':
            requireApproved(order); order.repairCompleted = true;
            order.paymentContext ??= ctx;
            if (order.status !== 'PAID') order.status = 'AWAITING_PAYMENT';
            emit('PaymentPending', { amountCents: order.budget!.totalCents }); break;
          default: throw new BadRequestException('Comando nao suportado');
        }
      } catch (error) { emit('CommandFailed', { commandType: msg.type, reason: (error as Error).message }); }
    }, msg.messageId);
    if (msg.type === 'CreatePayment') {
      const order = await this.store.get(msg.osId);
      if (order.repairCompleted) await this.checkout(msg.osId, ctx);
    }
  }
  async checkout(osId: string, ctx: Context, claims?: Claims): Promise<Order> {
    let create: { order: Order; payment: Payment } | undefined;
    let paymentContext = ctx;
    await this.store.change(osId, ctx, ({ order }) => {
      if (claims) authorize(order, claims, 'checkout');
      const budget = requireApproved(order);
      if (!order.repairCompleted) throw new ConflictException('Pagamento disponivel somente apos reparo');
      if (order.payment) return;
      paymentContext = order.paymentContext ?? { ...ctx, sagaId: order.preparedSagaId ?? ctx.sagaId };
      order.payment = { status: 'CREATING', key: randomUUID(), externalReference: `${order.osId}:${budget.version}`, amountCents: budget.totalCents, ...paymentContext };
      create = { order: structuredClone(order), payment: structuredClone(order.payment) };
    });
    if (create) {
      try { const preference = await this.provider.create(create.order, create.payment); await this.savePreference(osId, paymentContext, preference); }
      catch { await this.store.change(osId, paymentContext, ({ order, emit }) => { if (order.payment!.status === 'CREATING') order.payment!.status = 'UNKNOWN'; emit('PaymentPending', { reason: 'PROVIDER_RESULT_UNKNOWN', amountCents: order.payment!.amountCents }); }); }
    }
    return this.store.get(osId);
  }
  private async savePreference(osId: string, ctx: Context, preference: Preference): Promise<void> {
    const url = this.sandbox ? preference.sandbox_init_point ?? preference.init_point : preference.init_point;
    if (!preference.id || (!url?.startsWith('https://') && !(['test', 'development'].includes(process.env.NODE_ENV ?? '') && /^http:\/\/(localhost|127\.0\.0\.1|mercadopago|mercadopago-stub)(:\d+)?\//.test(url ?? '')))) throw new Error('Preferencia invalida');
    await this.store.change(osId, ctx, ({ order, emit }) => {
      order.payment!.preferenceId = preference.id; order.payment!.checkoutUrl = url;
      if (order.payment!.status !== 'APPROVED') order.payment!.status = 'PENDING';
      emit('PaymentCreated', { checkoutUrl: url, preferenceId: preference.id });
    });
  }
  async webhook(paymentId: string): Promise<void> { await this.acceptPayment(await this.provider.getPayment(paymentId)); }
  private async acceptPayment(payment: ProviderPayment): Promise<void> {
    if (typeof payment.external_reference !== 'string') throw new BadRequestException('Referencia ausente');
    const separator = payment.external_reference.lastIndexOf(':');
    const osId = payment.external_reference.slice(0, separator);
    const snapshot = await this.store.get(osId);
    const ctx: Context = { sagaId: snapshot.payment?.sagaId ?? osId, correlationId: snapshot.payment?.correlationId ?? `mp-${payment.id}`, ...(snapshot.payment?.traceparent ? { traceparent: snapshot.payment.traceparent } : {}) };
    await this.store.change(osId, ctx, ({ order, emit }) => {
      if (!order.payment || order.payment.externalReference !== payment.external_reference || payment.currency_id !== 'BRL' || !Number.isFinite(payment.transaction_amount) || Math.round(payment.transaction_amount * 100) !== order.payment.amountCents) throw new BadRequestException('Pagamento nao corresponde a OS/valor/moeda');
      if (order.payment.status === 'APPROVED') return;
      order.payment.paymentId = String(payment.id);
      if (payment.status === 'approved') {
        order.payment.status = 'APPROVED'; order.status = 'PAID'; emit('PaymentConfirmed', { amountCents: order.payment.amountCents, paymentId: String(payment.id) });
      } else {
        order.payment.status = payment.status === 'rejected' || payment.status === 'cancelled' ? 'REJECTED' : 'PENDING';
        emit('PaymentPending', { providerStatus: payment.status, amountCents: order.payment.amountCents });
      }
    }, `mp:${payment.id}:${payment.status}`);
  }
  async reconcile(): Promise<void> {
    for (const order of await this.store.pendingPayments()) {
      try {
        const ctx = { sagaId: order.osId, correlationId: `reconcile-${order.osId}` };
        if (!order.payment!.preferenceId) {
          const preference = await this.provider.findPreference(order.payment!.externalReference);
          if (preference) await this.savePreference(order.osId, ctx, preference);
        }
        for (const payment of await this.provider.findPayments(order.payment!.externalReference)) await this.acceptPayment(payment);
      } catch { /* Unknown outcomes remain durable for the next reconciliation; never repeat POST. */ }
    }
  }
}
