// ✅ 다른 모듈은 이 경로로만 재고를 조회·명령한다
import { getAvailableStock, postInventoryTransaction } from '@/modules/inventory/application';

export const read = getAvailableStock;
export const write = postInventoryTransaction;
