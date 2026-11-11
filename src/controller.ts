import { Body, Controller, Get, Headers, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { Request } from 'express';
import { BillingService } from './billing';
import { internalToken, JwtGuard } from './auth';
import { verifyWebhook } from './mercadopago';
import { Claims, Context } from './types';
import { captureTraceparent } from './trace-context';

type AuthRequest = Request & { claims: Claims };
function context(req: Request, osId: string): Context {
  const traceparent = captureTraceparent(typeof req.headers.traceparent === 'string' ? req.headers.traceparent : undefined);
  return { sagaId: osId, correlationId: String(req.headers['x-correlation-id'] ?? randomUUID()), ...(traceparent ? { traceparent } : {}) };
}
@ApiTags('Billing')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('api/v1/billing/orders')
export class BillingController {
  constructor(private readonly billing: BillingService) {}
  @Get(':osId')
  @ApiOperation({ summary: 'Consultar orcamento e pagamento da propria OS' })
  get(@Param('osId') id: string, @Req() req: AuthRequest) { return this.billing.get(id, req.claims); }
  @Put(':osId/budget')
  @ApiBody({ schema: { example: { items: [{ description: 'Reparo', quantity: 1, unitPriceCents: 10000 }] } } })
  budget(@Param('osId') id: string, @Body() body: { items: unknown }, @Req() req: AuthRequest) { return this.billing.budget(id, body?.items, req.claims, context(req, id)); }
  @Post(':osId/approve')
  approve(@Param('osId') id: string, @Req() req: AuthRequest) { return this.billing.decision(id, true, req.claims, context(req, id)); }
  @Post(':osId/reject')
  reject(@Param('osId') id: string, @Req() req: AuthRequest) { return this.billing.decision(id, false, req.claims, context(req, id)); }
  @Post(':osId/checkout')
  @ApiOperation({ summary: 'Obter checkout apos reparo; timeout exige reconciliacao' })
  checkout(@Param('osId') id: string, @Req() req: AuthRequest) { return this.billing.checkout(id, context(req, id), req.claims); }
  @Get(':osId/payment')
  async payment(@Param('osId') id: string, @Req() req: AuthRequest) { return (await this.billing.get(id, req.claims)).payment ?? { status: 'NOT_CREATED' }; }
}
@ApiTags('Internal')
@Controller('api/v1/billing/internal/orders')
export class InternalController {
  constructor(private readonly billing: BillingService) {}
  @Post()
  @ApiBody({ schema: { example: { osId: 'os-uuid', filialId: 'filial-uuid', clienteId: 'cliente-uuid', mecanicoId: 'mecanico-uuid' } } })
  create(@Headers('x-internal-token') token: string, @Body() body: Parameters<BillingService['create']>[0]) { internalToken(token); return this.billing.create(body); }
  @Get(':osId')
  get(@Headers('x-internal-token') token: string, @Param('osId') id: string) { internalToken(token); return this.billing.get(id); }
}
@ApiTags('Mercado Pago')
@Controller('api/v1/billing/webhooks')
export class WebhookController {
  constructor(private readonly billing: BillingService) {}
  @Post('mercadopago')
  async payment(@Query('data.id') id: string, @Headers('x-request-id') requestId: string, @Headers('x-signature') signature: string) {
    verifyWebhook(id, requestId, signature, process.env.MP_WEBHOOK_SECRET);
    await this.billing.webhook(id); return { received: true };
  }
}
@Controller('api/health')
export class HealthController {
  constructor(private readonly billing: BillingService) {}
  @Get('live') live() { return { status: 'ok' }; }
  @Get('ready') async ready() { await this.billing.store.health(); return { status: 'ok' }; }
}
@Controller('api/v1/billing')
export class BillingHealthController {
  constructor(private readonly billing: BillingService) {}
  @Get('health') async health() { await this.billing.store.health(); return { status: 'ok' }; }
}
