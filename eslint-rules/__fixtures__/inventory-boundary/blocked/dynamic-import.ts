export async function load(): Promise<unknown> {
  return import('@/generated/prisma/client');
}
