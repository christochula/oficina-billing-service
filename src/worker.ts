import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { BillingService } from './billing';
import { PostgresStore } from './store';
import tracer from 'dd-trace';
import { captureTraceparent, traceOutbox, withTraceIds } from './trace-context';
import { RequestMetrics } from './metrics';

export class Worker {
  private busy = false;
  private timer?: NodeJS.Timeout;
  private ticks = 0;
  constructor(private readonly store: PostgresStore, private readonly billing: BillingService, private readonly sqs: SQSClient, private readonly env: NodeJS.ProcessEnv = process.env, private readonly metrics: Pick<RequestMetrics, 'messageProcessed'> = { messageProcessed: () => {} }) {}
  start(): void { this.timer = setInterval(() => { void this.tick(); }, 1000); }
  stop(): void { if (this.timer) clearInterval(this.timer); }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.env.OS_QUEUE_URL) await this.store.deliverOutbox(async body => {
        await traceOutbox('billing.outbox.publish', body, async outgoing => {
          await this.sqs.send(new SendMessageCommand({ QueueUrl: this.env.OS_QUEUE_URL, MessageBody: JSON.stringify(outgoing), ...(this.env.OS_QUEUE_URL!.endsWith('.fifo') ? { MessageGroupId: outgoing.osId, MessageDeduplicationId: outgoing.messageId } : {}), MessageAttributes: { correlation_id: { DataType: 'String', StringValue: outgoing.correlationId } } }));
          console.log(JSON.stringify(withTraceIds({ event: 'billing.event.published', type: outgoing.type, messageId: outgoing.messageId, os_id: outgoing.osId, correlation_id: outgoing.correlationId, saga_id: outgoing.sagaId })));
        });
      });
      if (this.env.INBOX_QUEUE_URL) {
        const result = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: this.env.INBOX_QUEUE_URL, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 60 }));
        for (const message of result.Messages ?? []) {
          try {
            const body = JSON.parse(message.Body!);
            const parent = body.traceparent ? tracer.extract('http_headers', { traceparent: body.traceparent }) : null;
            await tracer.trace('billing.command', { ...(parent ? { childOf: parent } : {}), resource: body.type, tags: { 'span.kind': 'consumer', 'messaging.system': 'aws_sqs', 'saga.id': body.sagaId, 'os.id': body.osId, 'message.type': body.type, 'messaging.message_id': body.messageId, 'correlation.id': body.correlationId } }, async () => {
              await this.billing.command({ ...body, traceparent: captureTraceparent(body.traceparent) });
              this.metrics.messageProcessed();
              console.log(JSON.stringify(withTraceIds({ event: 'billing.command.processed', messageId: body.messageId, type: body.type, os_id: body.osId, correlation_id: body.correlationId, saga_id: body.sagaId })));
            });
            await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.env.INBOX_QUEUE_URL, ReceiptHandle: message.ReceiptHandle }));
          } catch { this.metrics.messageProcessed(true); console.error(JSON.stringify({ event: 'billing.command.failed', messageId: message.MessageId })); }
        }
      }
      this.ticks++;
      if (this.ticks % 15 === 0) await this.billing.reconcile();
    } catch { this.metrics.messageProcessed(true, 'billing-worker'); console.error(JSON.stringify({ event: 'billing.worker.failed' })); }
    finally { this.busy = false; }
  }
}
