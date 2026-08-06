// ✅ 전환 스크립트 — 원장에서 잔고를 재계산하는 일회성 작업
import { InventoryBalance, InventoryLedgerEntry } from '@/generated/prisma/client';

export type Row = [InventoryLedgerEntry, InventoryBalance];
