export async function load(): Promise<unknown> {
  return import('@/modules/inventory/infrastructure/repository');
}
