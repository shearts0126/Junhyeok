// ❌ inline type import 도 차단된다
import { type InventoryBalance } from '@/generated/prisma/client';

export type Balance = InventoryBalance;
