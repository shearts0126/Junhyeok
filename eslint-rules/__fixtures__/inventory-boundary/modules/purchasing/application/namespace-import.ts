// ❌ namespace import — 이후 속성 접근으로 우회 가능하므로 허용하지 않는다
import * as PrismaModels from '@/generated/prisma/client';

export const balance = PrismaModels;
