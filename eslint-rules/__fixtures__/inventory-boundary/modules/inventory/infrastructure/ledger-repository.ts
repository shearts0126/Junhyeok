// ✅ 유일한 정상 접근 지점
import { InventoryBalance, InventoryLedgerEntry } from '@/generated/prisma/client';

export type Ledger = InventoryLedgerEntry;
export type Balance = InventoryBalance;
