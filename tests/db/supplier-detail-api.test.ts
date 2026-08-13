import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  assertNoSupplierDetailQuery,
  createSupplier,
  getSupplier,
  SUPPLIER_CREATE_PERMISSION,
  SUPPLIER_READ_PERMISSION,
  SUPPLIER_UPDATE_PERMISSION,
  updateSupplier,
} from '@/modules/supplier/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * 거래처 단건 상세 supporting API DB 통합 테스트 (T06-4, §58) — 실제 PostgreSQL.
 *
 * 근거: `docs/17_설계복구_거래처공급조건.md` §80~ (D-9·D-36).
 *
 * 이 endpoint 는 `/master/suppliers/{id}` 의 새로고침·deep-link 를 성립시키는
 * **read-only supporting API** 다. 확인 대상:
 *   - 2차 권한 가드(`supplier.read`)와 **ADMIN bypass 부재**
 *   - 없는 id 는 404 (빈 객체 위장 금지)
 *   - 쿼리 파라미터 전면 거부(400)
 *   - 응답이 기존 `SupplierView` 그대로이고 staged 필드가 새지 않는지
 *   - **AuditLog 를 만들지 않는지** (read-only)
 *   - 기존 PATCH 계약 regression
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TSD-${RUN}-${suffix}`;

const WRITER_ID = 'eeeeeeee-0000-4000-8000-0000000e4001';
const READER_ID = 'eeeeeeee-0000-4000-8000-0000000e4002';
const NOPERM_ID = 'eeeeeeee-0000-4000-8000-0000000e4003';
const ACTOR_IDS = [WRITER_ID, READER_ID, NOPERM_ID];

/** SCM_STAFF 상당 — read/create/update. */
const WRITER: ActorContext = createActorContext({
  userId: WRITER_ID,
  email: 'supplier-detail-writer@deeppoint.test',
  name: '거래처 작성자',
  active: true,
  roles: ['SCM_STAFF'],
  permissions: [SUPPLIER_READ_PERMISSION, SUPPLIER_CREATE_PERMISSION, SUPPLIER_UPDATE_PERMISSION],
  requestId: 'req-supplier-detail-writer',
});

/** FINANCE 상당 — read 만. 상세는 볼 수 있어야 한다. */
const READER: ActorContext = createActorContext({
  userId: READER_ID,
  email: 'supplier-detail-reader@deeppoint.test',
  name: '재무 조회자',
  active: true,
  roles: ['FINANCE'],
  permissions: [SUPPLIER_READ_PERMISSION],
  requestId: 'req-supplier-detail-reader',
});

/** EXECUTIVE 상당 + ADMIN 역할 — supplier.* 없음. bypass 부재 증명용. */
const NO_PERMISSION: ActorContext = createActorContext({
  userId: NOPERM_ID,
  email: 'supplier-detail-noperm@deeppoint.test',
  name: '권한 없는 관리자',
  active: true,
  roles: ['ADMIN', 'EXECUTIVE'],
  permissions: ['sku.read'],
  requestId: 'req-supplier-detail-noperm',
});

let seq = 0;

async function newSupplierId(): Promise<string> {
  seq += 1;
  const result = await createSupplier(WRITER, {
    supplierCode: CODE(`S${String(seq).padStart(3, '0')}`),
    supplierName: `상세 테스트 거래처 ${seq}`,
    supplierType: 'MANUFACTURER',
    businessRegistrationNo: '123-45-67890',
    contactName: '홍길동',
    defaultLeadTimeDays: 0,
  });
  return result.supplier.id;
}

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`,
    ACTOR_IDS,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.idempotencyRecord.deleteMany({ where: { actorId: { in: ACTOR_IDS } } });
  await client.supplierSku.deleteMany({
    where: { supplier: { supplierCode: { startsWith: 'TSD-' } } },
  });
  await client.supplier.deleteMany({ where: { supplierCode: { startsWith: 'TSD-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: [
      { id: WRITER_ID, email: 'supplier-detail-writer@deeppoint.test', name: '거래처 작성자' },
      { id: READER_ID, email: 'supplier-detail-reader@deeppoint.test', name: '재무 조회자' },
      { id: NOPERM_ID, email: 'supplier-detail-noperm@deeppoint.test', name: '권한 없는 관리자' },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

describe('GET /api/suppliers/{id} — supporting API (D-9·D-36)', () => {
  it('1·7. supplier.read 로 조회되고 응답은 기존 SupplierView 그대로다', async () => {
    const id = await newSupplierId();
    const view = await getSupplier(WRITER, id);

    expect(Object.keys(view).sort()).toEqual(
      [
        'id',
        'supplierCode',
        'supplierName',
        'supplierType',
        'businessRegistrationNo',
        'contactName',
        'contactPhone',
        'contactEmail',
        'defaultLeadTimeDays',
        'status',
        'note',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(view.id).toBe(id);
    expect(view.status).toBe('ACTIVE');
    // ★ 저장된 0 이 폴백·null 로 뭉개지지 않는다 (G-03).
    expect(view.defaultLeadTimeDays).toBe(0);
    // ⛔ staged warehouse 필드가 새지 않는다 (D-20).
    expect('defaultWarehouseId' in view).toBe(false);
  });

  it('2. FINANCE(read 전용)도 상세를 볼 수 있다', async () => {
    const id = await newSupplierId();
    await expect(getSupplier(READER, id)).resolves.toMatchObject({ id });
  });

  it('★ 3·4. 권한 없는 EXECUTIVE·ADMIN 역할은 403 — bypass 없음', async () => {
    const id = await newSupplierId();
    await expect(getSupplier(NO_PERMISSION, id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('5. 없는 id 는 404 — 빈 객체로 위장하지 않는다', async () => {
    await expect(getSupplier(WRITER, '00000000-0000-4000-8000-00000000d001')).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });

  it('id 형식이 UUID 가 아니면 400 이다 (404 가 아니다)', async () => {
    await expect(getSupplier(WRITER, 'not-a-uuid')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('★ 6. 쿼리 파라미터는 전부 400 이다 — 조용히 무시하지 않는다', () => {
    expect(() => assertNoSupplierDetailQuery(new URLSearchParams(''))).not.toThrow();
    for (const bad of ['include=skus', 'page=1', 'asOf=2026-01-01', 'foo=1']) {
      expect(() => assertNoSupplierDetailQuery(new URLSearchParams(bad)), bad).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
  });

  it('★ 8. read-only — AuditLog 를 만들지 않는다', async () => {
    const id = await newSupplierId();
    const client = getPrismaClient();
    const before = await client.auditLog.count({ where: { entityType: 'Supplier', entityId: id } });

    await getSupplier(WRITER, id);
    await getSupplier(READER, id);

    const after = await client.auditLog.count({ where: { entityType: 'Supplier', entityId: id } });
    expect(after).toBe(before);
  });

  it('9. 기존 PATCH 계약 regression — 수정 후 상세가 최신값을 돌려준다', async () => {
    const id = await newSupplierId();
    await updateSupplier(WRITER, id, { contactName: '김철수', businessRegistrationNo: null });

    const view = await getSupplier(WRITER, id);
    expect(view.contactName).toBe('김철수');
    expect(view.businessRegistrationNo).toBeNull();
    // supplierCode·status 는 PATCH 대상이 아니므로 그대로다.
    expect(view.supplierCode.startsWith('TSD-')).toBe(true);
    expect(view.status).toBe('ACTIVE');
  });
});
