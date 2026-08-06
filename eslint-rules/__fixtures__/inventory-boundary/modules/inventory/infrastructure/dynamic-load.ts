// ✅ infrastructure 에서는 동적 import·require 도 막지 않는다
export async function load(): Promise<unknown> {
  return import('@/generated/prisma/client');
}

export const models: unknown = require('@/generated/prisma/client');
