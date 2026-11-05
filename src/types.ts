export interface Envelope {
  messageId: string; type: string; version: 1; sagaId: string; osId: string;
  filialId: string; correlationId: string; occurredAt: string; traceparent?: string;
  payload: Record<string, unknown>;
}
export interface BudgetItem { description: string; quantity: number; unitPriceCents: number; pecaId?: string }
export interface Budget { items: BudgetItem[]; totalCents: number; version: number; approved: boolean; frozen: boolean }
export interface Payment {
  status: 'CREATING' | 'UNKNOWN' | 'PENDING' | 'APPROVED' | 'REJECTED';
  key: string; externalReference: string; preferenceId?: string; checkoutUrl?: string;
  paymentId?: string; amountCents: number; sagaId?: string; correlationId?: string; traceparent?: string;
}
export interface Order {
  osId: string; filialId: string; clienteId: string; mecanicoId?: string;
  status: 'AWAITING_BUDGET' | 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'AWAITING_PAYMENT' | 'PAID';
  budget?: Budget; preparedSagaId?: string; releasedSagaIds?: string[]; repairCompleted?: boolean; payment?: Payment; paymentContext?: Context;
}
export interface Context { sagaId: string; correlationId: string; traceparent?: string }
export type Claims = { sub: string; role?: string; papel?: string; token_use?: string; client_id?: string; clienteId?: string; filialId?: string };
export interface Transaction { order: Order; emit(type: string, payload?: Record<string, unknown>): void }
export interface BillingStore {
  initialize(): Promise<void>; close(): Promise<void>; health(): Promise<void>;
  create(order: Order): Promise<Order>; get(osId: string): Promise<Order>;
  change<T>(osId: string, context: Context, callback: (tx: Transaction) => T | Promise<T>, messageId?: string): Promise<T | undefined>;
  pendingPayments(): Promise<Order[]>;
}
