import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Worker } from '../src/worker';
import { message } from './helpers';
import tracer from 'dd-trace';
describe('SQS worker reliable processing', () => {
  const env = { INBOX_QUEUE_URL: 'inbox', OS_QUEUE_URL: 'outbox' };
  function setup() {
    const store = { deliverOutbox: jest.fn(async (send: (body: unknown) => Promise<void>) => { await send(message('BudgetApproved')); }) };
    const billing = { command: jest.fn().mockResolvedValue(undefined), reconcile: jest.fn().mockResolvedValue(undefined) };
    const sqs = { send: jest.fn(async (cmd: unknown) => cmd instanceof ReceiveMessageCommand ? { Messages: [{ Body: JSON.stringify(message('PrepareApprovedBudget')), ReceiptHandle: 'receipt', MessageId: 'm' }] } : {}) };
    const metrics = { messageProcessed: jest.fn() };
    return { store, billing, sqs, metrics, worker: new Worker(store as never, billing as never, sqs as never, env, metrics) };
  }
  afterEach(() => jest.restoreAllMocks());
  it('continues the consumer child into domain context and records low-cardinality consumer metrics', async () => {
    const active = '00-1234567890abcdef1234567890abcdef-3333333333333333-01';
    jest.spyOn(tracer, 'scope').mockReturnValue({ active: () => ({ context: () => ({}) }) } as never);
    jest.spyOn(tracer, 'inject').mockImplementation((_span, format, carrier) => { if (format === 'http_headers') (carrier as Record<string,string>).traceparent = active; });
    const { worker, billing, metrics } = setup();
    await worker.tick();
    expect(billing.command).toHaveBeenCalledWith(expect.objectContaining({ traceparent: active, messageId: expect.any(String) }));
    expect(metrics.messageProcessed).toHaveBeenCalledWith();
    billing.command.mockRejectedValueOnce(new Error('storage unavailable'));
    await worker.tick();
    expect(metrics.messageProcessed).toHaveBeenCalledWith(true);
  });
  it('publishes outbox, consumes inbox and deletes only successful commands', async () => {
    const { worker, sqs, billing } = setup(); for (let i = 0; i < 15; i++) await worker.tick();
    expect(sqs.send.mock.calls.some(([cmd]) => cmd instanceof SendMessageCommand)).toBe(true); expect(sqs.send.mock.calls.some(([cmd]) => cmd instanceof DeleteMessageCommand)).toBe(true); expect(billing.command).toHaveBeenCalledTimes(15); expect(billing.reconcile).toHaveBeenCalledTimes(1);
  });
  it('retains failed commands and survives SQS outage', async () => {
    const { worker, sqs, billing } = setup(); billing.command.mockRejectedValueOnce(new Error('db offline')); await worker.tick();
    expect(sqs.send.mock.calls.some(([cmd]) => cmd instanceof DeleteMessageCommand)).toBe(false);
    sqs.send.mockRejectedValueOnce(new Error('offline')); await worker.tick();
  });
  it('sets FIFO grouping and stable event deduplication when OS queue requires it', async () => {
    const { store, billing, sqs } = setup(); const worker = new Worker(store as never, billing as never, sqs as never, { OS_QUEUE_URL: 'os.fifo' }); await worker.tick();
    const send = sqs.send.mock.calls.find(([cmd]) => cmd instanceof SendMessageCommand)![0] as SendMessageCommand; expect(send.input.MessageGroupId).toBe('os-1'); expect(send.input.MessageDeduplicationId).toBeDefined();
  });
  it('supports disabled queues, empty receives, busy guard and timer lifecycle', async () => {
    jest.useFakeTimers(); const { store, billing, sqs } = setup(); const disabled = new Worker(store as never, billing as never, sqs as never, {}); disabled.stop(); disabled.start(); jest.advanceTimersByTime(1000); disabled.stop(); await disabled.tick();
    const worker = new Worker(store as never, billing as never, { send: async () => ({}) } as never, env); await Promise.all([worker.tick(), worker.tick()]); jest.useRealTimers();
  });
});
