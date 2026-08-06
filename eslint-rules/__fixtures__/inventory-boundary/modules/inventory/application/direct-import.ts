// ❌ application 계층에서도 금지 (영속성 세부사항 격리)
import { InventoryBalance } from '@/generated/prisma/client';

export type Balance = InventoryBalance;
