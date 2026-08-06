// 재고 모델 이름이 import 문에 없어도 차단된다
import { repository } from '@/modules/inventory/infrastructure/repository';
export const repo = repository;
