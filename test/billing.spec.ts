import { BillingService } from '../src/billing';
import { MemoryStore, orderInput, client, mechanic, context, items, message, admin } from './helpers';

describe('Billing business behavior', () => {
  let store: MemoryStore; let service: BillingService;
  const preference = { id: 'pref-1', init_point: 'https://pay.example/1', sandbox_init_point: 'https://sandbox.example/1' };
  const provider = { create: jest.fn(), findPreference: jest.fn(), findPayments: jest.fn(), getPayment: jest.fn() };
  beforeEach(async () => { jest.resetAllMocks(); store = new MemoryStore(); service = new BillingService(store, provider); provider.create.mockResolvedValue(preference); provider.findPayments.mockResolvedValue([]); await service.create(orderInput); });
  async function approved() { await service.budget('os-1', items, mechanic, context); await service.decision('os-1', true, client, context); }
  it('generates versioned budgets, client approval and idempotent repeated decision', async () => {
    await service.budget('os-1', items, mechanic, context); await service.budget('os-1', items, admin, context);
    expect((await service.get('os-1', client)).budget).toMatchObject({ totalCents: 5000, version: 2, approved: false });
    await service.decision('os-1', true, client, context); await service.decision('os-1', true, client, context);
    expect(store.events.filter(event => event.type === 'BudgetApproved')).toHaveLength(1);
    await expect(service.budget('os-1', items, mechanic, context)).rejects.toThrow('nao pode');
  });
  it('rejects budget, repeats rejection safely and permits a new version', async () => {
    await service.budget('os-1', items, mechanic, context); await service.decision('os-1', false, client, context); await service.decision('os-1', false, client, context);
    expect((await service.get('os-1')).status).toBe('REJECTED');
    await service.budget('os-1', items, mechanic, context); expect((await service.get('os-1')).budget?.version).toBe(2);
  });
  it('prevents decision before budget and rejects other clients', async () => {
    await expect(service.decision('os-1', true, client, context)).rejects.toThrow();
    await expect(service.get('os-1', { sub: 'other', role: 'CLIENTE' })).rejects.toThrow();
    await expect(service.create({ ...orderInput, clienteId: 'other' })).rejects.toThrow();
    await expect(service.create({ ...orderInput, osId: '' })).rejects.toThrow();
    await expect(service.create(undefined as never)).rejects.toThrow();
  });
  it('whitelists internal creation and preserves existing data', async () => {
    await service.create({ osId: 'os-2', filialId: 'branch-1', clienteId: 'client-1', repairCompleted: true, budget: { approved: true } } as never);
    expect((await service.get('os-2')).repairCompleted).toBeUndefined();
    await approved(); await service.create(orderInput); expect((await service.get('os-1')).budget?.approved).toBe(true);
  });
  it('prepares, compensates, deduplicates and fences late commands', async () => {
    await approved(); const prepare = message('PrepareApprovedBudget', { traceparent: '00-abc' });
    await service.command(prepare); await service.command(prepare);
    expect(store.events.filter(event => event.type === 'BudgetPrepared')).toHaveLength(1);
    await service.command(message('PrepareApprovedBudget', { sagaId: 'other-saga' })); expect(store.events.at(-1)?.type).toBe('CommandFailed');
    await service.command(message('ReleaseBudgetPreparation', { sagaId: 'other-saga' })); expect((await service.get('os-1')).budget?.frozen).toBe(true);
    await service.command(message('ReleaseBudgetPreparation'));
    expect((await service.get('os-1')).budget).toMatchObject({ frozen: false, approved: true });
    await service.command(message('PrepareApprovedBudget')); expect(store.events.at(-1)?.payload?.reason).toContain('compensada');
  });
  it('fails unsupported/unapproved commands and does not ACK invalid tenant', async () => {
    await service.command(message('PrepareApprovedBudget')); expect(store.events.at(-1)?.type).toBe('CommandFailed');
    await service.command(message('NoSuchCommand')); expect(store.events.at(-1)?.payload?.commandType).toBe('NoSuchCommand');
    await expect(service.command(message('CreatePayment', { filialId: 'other' }))).rejects.toThrow();
    await expect(service.command({})).rejects.toThrow();
    await service.command(message('ReleaseBudgetPreparation')); expect(store.events.at(-1)?.type).toBe('BudgetReleased');
  });
  it('links mechanic only through trusted command and rejects invalid assignment', async () => {
    await service.command(message('AssignMechanic', { payload: { mecanicoId: 'new-mechanic' } }));
    expect((await service.get('os-1')).mecanicoId).toBe('new-mechanic');
    expect(store.events.at(-1)?.type).toBe('MechanicLinked');
    await service.command(message('AssignMechanic')); expect(store.events.at(-1)?.type).toBe('CommandFailed');
  });
  it('forbids checkout before repair, then creates only one preference and exposes payment', async () => {
    await approved(); await expect(service.checkout('os-1', context, client)).rejects.toThrow('apos reparo');
    const command = message('CreatePayment'); await service.command(command); await service.command(command);
    const result = await service.checkout('os-1', context, client);
    expect(result.payment).toMatchObject({ status: 'PENDING', checkoutUrl: preference.init_point, amountCents: 5000 });
    expect(provider.create).toHaveBeenCalledTimes(1);
    await service.command(message('ReleaseBudgetPreparation')); expect(store.events.at(-1)?.type).toBe('CommandFailed');
  });
  it('persists unknown provider outcome and reconciles without another POST', async () => {
    await approved(); provider.create.mockRejectedValueOnce(new Error('timeout'));
    await service.command(message('CreatePayment')); expect((await service.get('os-1')).payment?.status).toBe('UNKNOWN');
    await service.checkout('os-1', context); expect(provider.create).toHaveBeenCalledTimes(1);
    provider.findPreference.mockResolvedValueOnce(undefined); await service.reconcile();
    provider.findPreference.mockResolvedValueOnce(preference); await service.reconcile();
    expect((await service.get('os-1')).payment?.status).toBe('PENDING');
  });
  it('retains unknown outcome when reconciliation fails or provider response is invalid', async () => {
    await approved(); provider.create.mockResolvedValueOnce({ id: 'x', init_point: 'http://unsafe' }); await service.command(message('CreatePayment'));
    provider.findPreference.mockRejectedValueOnce(new Error('offline')); await service.reconcile();
    expect((await service.get('os-1')).payment?.status).toBe('UNKNOWN');
  });
  it('preserves command saga when customer checkout wins race before automatic checkout', async () => {
    await approved();
    await store.change('os-1', context, ({ order }) => { order.repairCompleted = true; order.paymentContext = context; });
    await service.checkout('os-1', { sagaId: 'human-request', correlationId: 'human-correlation' }, client);
    expect((await service.get('os-1')).payment?.sagaId).toBe(context.sagaId);
    expect(store.events.find(event => event.type === 'PaymentCreated')?.sagaId).toBe(context.sagaId);
    provider.getPayment.mockResolvedValue({ id: 123, status: 'approved', external_reference: 'os-1:1', currency_id: 'BRL', transaction_amount: 50 });
    await service.webhook('123'); expect(store.events.at(-1)?.sagaId).toBe(context.sagaId);
  });
  it('validates authoritative payment, deduplicates approval and does not undo payment', async () => {
    await approved(); await service.command(message('CreatePayment'));
    const payment = { id: 123, status: 'approved', external_reference: 'os-1:1', currency_id: 'BRL', transaction_amount: 50 };
    provider.getPayment.mockResolvedValue(payment); await service.webhook('123'); await service.webhook('123');
    expect((await service.get('os-1')).status).toBe('PAID'); expect(store.events.filter(event => event.type === 'PaymentConfirmed')).toHaveLength(1);
    provider.getPayment.mockResolvedValue({ ...payment, status: 'pending' }); await service.webhook('123'); expect((await service.get('os-1')).status).toBe('PAID');
    await service.command(message('CreatePayment')); expect((await service.get('os-1')).status).toBe('PAID');
  });
  it('rejects mismatched amounts and references, keeps pending/rejected repairs completed', async () => {
    await approved(); await service.command(message('CreatePayment'));
    const payment = { id: 123, status: 'pending', external_reference: 'os-1:1', currency_id: 'BRL', transaction_amount: 50 };
    provider.getPayment.mockResolvedValue({ ...payment, transaction_amount: 1 }); await expect(service.webhook('123')).rejects.toThrow('nao corresponde');
    provider.getPayment.mockResolvedValue({ ...payment, external_reference: null }); await expect(service.webhook('123')).rejects.toThrow('Referencia');
    provider.getPayment.mockResolvedValue(payment); await service.webhook('123'); expect((await service.get('os-1')).payment?.status).toBe('PENDING');
    provider.getPayment.mockResolvedValue({ ...payment, status: 'rejected' }); await service.webhook('123'); expect((await service.get('os-1')).payment?.status).toBe('REJECTED');
    expect((await service.get('os-1')).repairCompleted).toBe(true);
  });
  it('reconciles approved payment without webhook and always uses Checkout Pro init_point', async () => {
    await approved(); await service.command(message('CreatePayment'));
    expect((await service.get('os-1')).payment?.checkoutUrl).toBe(preference.init_point);
    provider.findPayments.mockResolvedValue([{ id: 'p', status: 'approved', external_reference: 'os-1:1', currency_id: 'BRL', transaction_amount: 50 }]);
    await service.reconcile(); expect((await service.get('os-1')).status).toBe('PAID');
  });
  it('recovers test payment approval after rejection when the second webhook is lost', async () => {
    await approved(); await service.command(message('CreatePayment'));
    provider.getPayment.mockResolvedValue({ id: 'rejected-attempt', status: 'rejected', external_reference: 'os-1:1', currency_id: 'BRL', transaction_amount: 50, live_mode: false });
    await service.webhook('rejected-attempt');
    expect((await service.get('os-1')).payment?.status).toBe('REJECTED');
    expect((await service.get('os-1')).status).toBe('AWAITING_PAYMENT');
    provider.findPayments.mockResolvedValue([
      { id: 'approved-attempt', status: 'approved', external_reference: 'os-1:1', currency_id: 'BRL', transaction_amount: 50, live_mode: false },
      { id: 'rejected-attempt', status: 'rejected', external_reference: 'os-1:1', currency_id: 'BRL', transaction_amount: 50, live_mode: false },
    ]);
    await service.reconcile(); await service.reconcile();
    expect((await service.get('os-1')).status).toBe('PAID');
    expect((await service.get('os-1')).payment?.paymentId).toBe('approved-attempt');
    expect(store.events.filter(event => event.type === 'PaymentConfirmed')).toHaveLength(1);
    expect(store.events.at(-1)?.sagaId).toBe(context.sagaId);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
});
