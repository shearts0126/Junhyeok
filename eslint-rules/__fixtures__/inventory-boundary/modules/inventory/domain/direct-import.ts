// ❌ 같은 모듈이어도 domain 에서는 금지
import type { InventoryLedgerEntry } from '@/generated/prisma/client';

export type LedgerEntry = InventoryLedgerEntry;
