// ❌ presentation 계층에서도 금지
import { InventoryBalance, InventoryLedgerEntry } from '@/generated/prisma/client';

export type Pair = [InventoryBalance, InventoryLedgerEntry];
