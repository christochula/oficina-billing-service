import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { BillingService } from './billing';
import { PostgresStore } from './store';
import tracer from 'dd-trace';

export class Worker {
  private busy = false;
  private timer?: NodeJS.Timeout;
  private ticks = 0;
  constructor(private readonly store: PostgresStore, private readonly billing: BillingService, private readonly sqs: SQSClient, private readonly env: NodeJS.ProcessEnv = process.env) {}
  start(): void { this.timer = setInterval(() => { void this.tick(); }, 1000); }
  stop(): void { if (this.timer) clearInterval(this.timer); }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.env.OS_QUEUE_URL) await this.store.deliverOutbox(async body => {
        await this.sqs.send(new SendMessageCommand({ QueueUrl: this.env.OS_QUEUE_URL, MessageBody: JSON.stringify(body), ...(this.env.OS_QUEUE_URL!.endsWith('.fifo') ? { MessageGroupId: body.osId, MessageDeduplicationId: body.messageId } : {}), MessageAttributes: { correlation_id: { DataType: 'String', StringValue: body.correlationId } } }));
        console.log(JSON.stringify({ event: 'billing.event.published', type: body.type, messageId: body.messageId, correlation_id: body.correlationId, saga_id: body.sagaId }));
      });
      if (this.env.INBOX_QUEUE_URL) {
        const result = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: this.env.INBOX_QUEUE_URL, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 60 }));
        for (const message of result.Messages ?? []) {
          try {
            const body = JSON.parse(message.Body!);
            const parent = body.traceparent ? tracer.extract('http_headers', { traceparent: body.traceparent }) : null;
            await tracer.trace('billing.command', { ...(parent ? { childOf: parent } : {}), tags: { 'saga.id': body.sagaId, 'messaging.message_id': body.messageId, 'correlation.id': body.correlationId } }, async () => {
              await this.billing.command(body);
              const log = { event: 'billing.command.processed', messageId: body.messageId, type: body.type, correlation_id: body.correlationId, saga_id: body.sagaId };
              const span = tracer.scope().active(); if (span) tracer.inject(span.context(), 'log', log);
              console.log(JSON.stringify(log));
            });
            await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.env.INBOX_QUEUE_URL, ReceiptHandle: message.ReceiptHandle }));
          } catch { console.error(JSON.stringify({ event: 'billing.command.failed', messageId: message.MessageId })); }
        }
      }
      this.ticks++;
      if (this.ticks % 15 === 0) await this.billing.reconcile();
    } catch { console.error(JSON.stringify({ event: 'billing.worker.failed' })); }
    finally { this.busy = false; }
  }
}
