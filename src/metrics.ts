import { createSocket, Socket } from 'node:dgram';

/** DogStatsD distributions use milliseconds, matching the shared Datadog monitor contract. */
export class RequestMetrics {
  private readonly socket?: Socket;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, factory: () => Socket = () => createSocket('udp4')) {
    if (env.DD_METRICS_ENABLED !== 'true') return;
    this.socket = factory(); this.socket.unref(); this.socket.on('error', () => { /* Telemetry cannot interrupt requests. */ });
  }
  observe(durationMs: number, method: string, statusCode: number): void {
    if (!this.socket || !Number.isFinite(durationMs) || durationMs < 0) return;
    const tags = [
      `method:${method.replace(/[^A-Z]/g, '').slice(0, 16)}`,
      `status_code:${Math.trunc(statusCode)}`,
      `service:${this.env.DD_SERVICE ?? 'oficina-billing-service'}`,
      `env:${this.env.DD_ENV ?? 'homolog'}`,
      `version:${this.env.DD_VERSION ?? '4.0.0'}`,
    ];
    const packet = `oficina.api.request.duration_ms:${durationMs.toFixed(3)}|d|#${tags.join(',')}`;
    try { this.socket.send(Buffer.from(packet), Number(this.env.DD_DOGSTATSD_PORT ?? 8125), this.env.DD_AGENT_HOST ?? '127.0.0.1', () => {}); }
    catch { /* A monitoring outage cannot fail an HTTP request. */ }
  }
  close(): void { this.socket?.close(); }
}
