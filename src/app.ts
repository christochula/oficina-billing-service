import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { BillingService } from './billing';
import { BillingController, InternalController, WebhookController, HealthController, BillingHealthController } from './controller';
import { MercadoPago } from './mercadopago';
import { PostgresStore } from './store';

export function makeStore(): PostgresStore {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL obrigatoria');
  return new PostgresStore(new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true, ca: readFileSync(process.env.DATABASE_SSL_CA_FILE ?? '/app/certs/rds-ca.pem', 'utf8') } : false, max: 10 }));
}
@Module({ controllers: [BillingController, InternalController, WebhookController, HealthController, BillingHealthController], providers: [{ provide: BillingService, useFactory: () => new BillingService(makeStore(), new MercadoPago()) }] })
export class AppModule {}
