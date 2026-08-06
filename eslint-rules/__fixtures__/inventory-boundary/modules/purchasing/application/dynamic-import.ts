// ❌ 동적 import 우회
export async function load(): Promise<unknown> {
  return import('@/generated/prisma/client');
}
