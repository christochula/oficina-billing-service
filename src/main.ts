import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SQSClient } from '@aws-sdk/client-sqs';
import { AppModule } from './app';
import { BillingService } from './billing';
import { PostgresStore } from './store';
import { Worker } from './worker';
import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import tracer from 'dd-trace';
import { RequestMetrics } from './metrics';

async function bootstrap(): Promise<void> {
  if (!process.env.JWT_SECRET || !process.env.AUTH_CLIENT_LOOKUP_TOKEN) throw new Error('Segredos JWT e token interno obrigatorios');
  const app = await NestFactory.create(AppModule);
  const metrics = new RequestMetrics();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = performance.now();
    const supplied = req.headers['x-correlation-id'];
    const correlationId = typeof supplied === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(supplied) ? supplied : randomUUID();
    req.headers['x-correlation-id'] = correlationId; res.setHeader('X-Correlation-Id', correlationId);
    res.on('finish', () => { metrics.observe(performance.now() - started, req.method, res.statusCode); const record = { event: 'http.request', method: req.method, status: res.statusCode, correlation_id: correlationId }; const span = tracer.scope().active(); if (span) tracer.inject(span.context(), 'log', record); console.log(JSON.stringify(record)); });
    next();
  });
  app.enableCors({ origin: process.env.CORS_ORIGIN ?? false });
  const billing = app.get(BillingService);
  await billing.store.initialize();
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Oficina Billing').setVersion('4.0.0').addBearerAuth().build());
  SwaggerModule.setup('api/docs', app, document);
  const worker = new Worker(billing.store as PostgresStore, billing, new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1', ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}) }));
  worker.start();
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
  const shutdown = async () => { worker.stop(); metrics.close(); await app.close(); await billing.store.close(); };
  process.on('SIGTERM', () => { void shutdown(); }); process.on('SIGINT', () => { void shutdown(); });
}
void bootstrap();
