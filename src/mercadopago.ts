import { UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Order, Payment } from './types';

export interface Preference { id: string; init_point: string; sandbox_init_point?: string }
export interface ProviderPayment { id: string | number; status: string; external_reference: string; transaction_amount: number; currency_id: string; collector_id?: number }
export interface PaymentProvider {
  create(order: Order, payment: Payment): Promise<Preference>;
  findPreference(reference: string): Promise<Preference | undefined>;
  findPayments(reference: string): Promise<ProviderPayment[]>;
  getPayment(id: string): Promise<ProviderPayment>;
}

export class MercadoPago implements PaymentProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly http: typeof fetch = fetch) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.env.MP_ACCESS_TOKEN) throw new Error('MP_ACCESS_TOKEN nao configurado');
    const base = this.env.MP_API_BASE_URL ?? 'https://api.mercadopago.com';
    if (!base.startsWith('https://') && !(['test', 'development'].includes(this.env.NODE_ENV ?? '') && /^http:\/\/(localhost|127\.0\.0\.1|mercadopago-stub)(:\d+)?$/.test(base))) throw new Error('MP_API_BASE_URL insegura');
    const response = await this.http(`${base}${path}`, { ...init, signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${this.env.MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...init.headers } });
    if (!response.ok) throw new Error(`Mercado Pago HTTP ${response.status}`);
    return await response.json() as T;
  }
  async create(order: Order, payment: Payment): Promise<Preference> {
    if (!this.env.MP_NOTIFICATION_URL || !this.env.MP_BACK_URL) throw new Error('URLs Mercado Pago nao configuradas');
    return this.request('/checkout/preferences', { method: 'POST', headers: { 'X-Idempotency-Key': payment.key }, body: JSON.stringify({
      external_reference: payment.externalReference,
      items: [{ id: order.osId, title: `Reparo OS ${order.osId}`, quantity: 1, currency_id: 'BRL', unit_price: payment.amountCents / 100 }],
      notification_url: this.env.MP_NOTIFICATION_URL,
      back_urls: { success: this.env.MP_BACK_URL, pending: this.env.MP_BACK_URL, failure: this.env.MP_BACK_URL },
      metadata: { os_id: order.osId, filial_id: order.filialId, budget_version: order.budget!.version },
    }) });
  }
  async findPreference(reference: string): Promise<Preference | undefined> {
    const result = await this.request<{ elements: Preference[] }>(`/checkout/preferences/search?external_reference=${encodeURIComponent(reference)}`);
    if (result.elements.length > 1) throw new Error('Mais de uma preferencia: reconciliacao manual necessaria');
    if (!result.elements[0]) return undefined;
    return this.request(`/checkout/preferences/${encodeURIComponent(result.elements[0].id)}`);
  }
  async findPayments(reference: string): Promise<ProviderPayment[]> {
    const result = await this.request<{ results: ProviderPayment[] }>(`/v1/payments/search?external_reference=${encodeURIComponent(reference)}&sort=date_created&criteria=desc`);
    return result.results;
  }
  getPayment(id: string): Promise<ProviderPayment> { return this.request(`/v1/payments/${encodeURIComponent(id)}`); }
}

export function verifyWebhook(id: string, requestId: string | undefined, signature: string | undefined, secret: string | undefined, now = Date.now()): void {
  if (!id || !requestId || !signature || !secret) throw new UnauthorizedException('Webhook sem assinatura');
  const parts = Object.fromEntries(signature.split(',').map(part => part.trim().split('=')));
  const stamp = Number(parts.ts);
  const milliseconds = stamp > 1e12 ? stamp : stamp * 1000;
  if (!Number.isFinite(stamp) || Math.abs(now - milliseconds) > 5 * 60 * 1000 || !/^[a-f0-9]{64}$/i.test(parts.v1 ?? '')) throw new UnauthorizedException('Webhook expirado ou invalido');
  const expected = createHmac('sha256', secret).update(`id:${id.toLowerCase()};request-id:${requestId};ts:${parts.ts};`).digest();
  if (!timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'))) throw new UnauthorizedException('Assinatura invalida');
}
