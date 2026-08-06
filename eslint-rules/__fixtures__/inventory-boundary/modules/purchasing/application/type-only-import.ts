// ❌ type-only import 도 차단된다
import type { InventoryLedgerEntry } from '@/generated/prisma/client';

export type Entry = InventoryLedgerEntry;
