// ✅ Prisma 네임스페이스·클라이언트 타입은 제한 대상이 아니다
import { Prisma, type PrismaClient } from '@/generated/prisma/client';

export type Client = PrismaClient;
export const decimal = Prisma.Decimal;
