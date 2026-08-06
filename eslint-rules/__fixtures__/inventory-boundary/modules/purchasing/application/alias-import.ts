// ❌ 별칭으로 이름을 바꿔도 차단된다
import { InventoryBalance as Balance } from '@/generated/prisma/client';

export type StockBalance = Balance;
