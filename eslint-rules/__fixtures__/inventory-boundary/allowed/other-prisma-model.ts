// 재고 원장·잔고가 아닌 모델은 정상 import
import { Sku, PurchaseOrder } from '@/generated/prisma/client';
export type Pair = [Sku, PurchaseOrder];
