import { randomUUID } from 'node:crypto';

import { getPrismaClient } from '@/shared/db';

/**
 * 다른 모듈의 DB 테스트가 **실재하는 창고 UUID** 를 필요로 할 때 쓰는 fixture
 * (T08-1 = v0.2 T2-1A).
 *
 * T08-1 이 staged warehouse scalar 5종을 real FK 로 landing 시킨 뒤부터
 * (`docs/19_설계복구_Warehouse.md §W-D15`), Supplier·BOM·ExternalMapping 테스트가
 * 쓰던 "유령 UUID" 는 DB 가 거부한다. 그 테스트들이 검증하려던 것은 *창고의
 * 존재* 가 아니라 **application 이 창고를 조회·join 하지 않는다**는 계약이므로,
 * 유령 UUID 를 실재 UUID 로 바꾸면 원래 의도가 그대로 보존된다.
 *
 * ⛔ 이것은 seed 가 아니다 — 창고 15종 seed 는 T08-2 소유이며 여기서 만드는
 *    행은 테스트 prefix 를 가진 일회용 데이터다.
 */

/**
 * 창고 1개 + 그 창고의 `DEFAULT` 로케이션 1개를 만든다.
 *
 * 순서는 `docs/19 §W-D7` 그대로다 — location UUID 를 미리 만들어 warehouse 를
 * 먼저 INSERT 하고, location 을 이어서 INSERT 한 뒤 COMMIT 에서 deferred
 * composite FK 를 검증받는다. ⛔ 사후 UPDATE 문이 없다.
 *
 * @param warehouseCode 전역 UNIQUE 여야 한다 — 호출자의 테스트 prefix 를 쓴다.
 */
export async function createTestWarehouse(warehouseCode: string): Promise<string> {
  const warehouseId = randomUUID();
  const locationId = randomUUID();

  await getPrismaClient().$transaction(async (tx) => {
    await tx.warehouse.create({
      data: {
        id: warehouseId,
        warehouseCode,
        warehouseName: `테스트 창고 ${warehouseCode}`,
        warehouseType: 'INTERNAL',
        defaultLocationId: locationId,
      },
    });
    await tx.warehouseLocation.create({
      data: {
        id: locationId,
        warehouseId,
        locationCode: 'DEFAULT',
        locationName: '기본 로케이션',
      },
    });
  });

  return warehouseId;
}

/**
 * `warehouseCode` 가 주어진 prefix 로 시작하는 창고와 그 로케이션을 지운다.
 *
 * ⚠️ `warehouse` ↔ `warehouse_location` 은 서로를 **RESTRICT** 로 참조하므로
 *    (docs/19 §W-D19) 순서만으로는 풀리지 않는다 — 어느 쪽을 먼저 지워도
 *    상대가 막는다. 이는 사고가 아니라 물리삭제 금지 정책과 정합하는 성질이며,
 *    운영 경로에는 창고 물리삭제가 아예 없다. 테스트 잔여물 정리에 한해
 *    FK 검사를 잠시 끈다 (`audit_log` 트리거를 DISABLE 하는 기존 정리 선례와
 *    같은 성격).
 * ⛔ 운영 코드에는 이 경로가 없다.
 *
 * ── ★ 왜 트랜잭션 안의 `SET LOCAL` 인가 ─────────────────────────────
 * `session_replication_role` 은 **세션(=커넥션) 단위** 설정인데 PrismaClient 는
 * driver adapter 뒤에 커넥션 **풀**을 둔다. 따라서 평범한
 * `SET ... = replica` → try/finally → `SET ... = origin` 은 안전하지 않다:
 * 두 문장이 서로 다른 커넥션에 갈 수 있어 ① DELETE 가 replica 가 아닌
 * 커넥션에서 실행되거나 ② **replica 인 채로 남은 커넥션이 풀에 반환**되어
 * 이후 다른 DB 테스트의 FK 검사가 통째로 무력화된다.
 *
 * `$transaction` 은 하나의 커넥션에 고정되고, `SET LOCAL` 은 COMMIT/ROLLBACK
 * 시점에 **PostgreSQL 이 스스로 되돌린다** — 예외가 나도 누출이 없다.
 * try/finally 보다 강한 보장이며, 그래서 `finally` 로 복구하지 않는다.
 */
export async function deleteTestWarehouses(codePrefix: string): Promise<void> {
  await getPrismaClient().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await tx.$executeRawUnsafe(
      `DELETE FROM warehouse_location WHERE warehouse_id IN
         (SELECT id FROM warehouse WHERE warehouse_code LIKE $1)`,
      `${codePrefix}%`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM warehouse WHERE warehouse_code LIKE $1`,
      `${codePrefix}%`,
    );
  });
}
