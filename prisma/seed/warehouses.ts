import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import {
  insertWarehouseWithDefaultLocation,
  type AtomicWarehouseInput,
} from '@/modules/warehouse/application';

/**
 * 창고 15종 + DEFAULT 로케이션 15개 시드 (T08-2).
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` §W-D37(exact 15행) · §W-D11(IN_TRANSIT) ·
 *    §W-D13·§W-D38(supplier staged link) · §W-D14(externalSystem) · §W-D35(audit 0).
 *    원천은 `docs/06 §12.8` 창고 매핑표(D-02)다.
 *
 * ## ★ 왜 public create service 를 재사용하지 않는가
 *
 * seed 와 API 는 **계약이 정반대인 지점이 셋** 있다:
 *
 * | | public API | seed |
 * |---|---|---|
 * | `SUPPLIER_SITE` + `supplierId=null` | **400** (§W-D13) | **정상** (transitional) |
 * | `IN_TRANSIT` 창고 생성 | **400** (§W-D12) | **seed 만이 owner** |
 * | AuditLog | CREATE 2건 | **0건** (§W-D35) |
 *
 * 그래서 `createWarehouse()` 를 부르면 11건이 즉시 400 으로 실패한다.
 * ⛔ 그렇다고 public 계약을 우회하는 뒷문을 만들지도 않는다 — 공유하는 것은
 *    W-D7 의 INSERT 순서(`insertWarehouseWithDefaultLocation`)뿐이다.
 *
 * ## ★ `SUPPLIER_SITE` 11건의 `supplierId` 가 null 인 이유
 *
 * `docs/06 §12.8` 이 창고를 **Phase 3**, 거래처를 **Phase 7** 에서 이관한다고
 * 명시한다 — 창고 seed 시점에는 연결할 거래처가 **존재하지 않는다**.
 * 문서상 상태는 `UNLINKED_PENDING_SUPPLIER_MIGRATION` 이며(§W-D38) DB enum·
 * 컬럼이 아니다. 연결은 마이그레이션 Phase 7(`T4-19`)이 backfill 한다.
 *
 * ⛔ `supplierCode` 를 추정해 **fake Supplier 를 만들지 않는다** — `BOC`·`IJC`
 *    같은 축약어는 warehouse/source 코드이지 거래처 코드가 아니다. 이름
 *    유사성만으로 FK 를 연결하지도 않는다.
 *
 * ## idempotency
 *
 * `warehouseCode` 는 전역 UNIQUE 이므로 그것이 natural key 다. 이미 있으면
 * **건드리지 않고 건너뛴다** — ⛔ 기존 행을 수정·삭제하지 않는다.
 * ⚠️ `upsert` 를 쓰지 않는 이유: 순환 FK 때문에 create 분기가
 *    `defaultLocationId` 를 요구하는데, 그 값은 같은 트랜잭션에서 만들어질
 *    로케이션의 id 라 `upsert` 한 문장으로는 표현할 수 없다.
 */

type WarehouseSeedClient =
  Pick<PrismaClient, 'warehouse' | 'warehouseLocation'> | Prisma.TransactionClient;

interface WarehouseSeed {
  readonly warehouseCode: string;
  readonly warehouseName: string;
  readonly warehouseType: AtomicWarehouseInput['warehouseType'];
}

/**
 * ★ **정확히 15개다** (§W-D37). ⛔ 임의 추가·삭제 금지.
 *
 * `BOC`(4)·`BON`(14)은 원본에서 둘 다 "본코스메틱" 이지만 **별도 창고 2개로
 * 보존**한다 — 동일 업체인지는 Phase 7 source evidence 로 결정한다(§W-D39).
 * ⛔ 미리 합치지 않는다. 잘못 합치면 되돌리기 어렵다.
 *
 * 미르글로벌(종료)·아마존 FBA(R4)는 제외다 (`docs/06 §12.8`).
 */
const WAREHOUSE_SEEDS: readonly WarehouseSeed[] = [
  // 3PL 3곳
  { warehouseCode: 'OLPUN', warehouseName: '올펀', warehouseType: 'THREE_PL' },
  { warehouseCode: 'PUMGO', warehouseName: '품고', warehouseType: 'THREE_PL' },
  { warehouseCode: 'RODIT', warehouseName: '로딧', warehouseType: 'THREE_PL' },

  // 제조사 보관처 11곳 — 전부 supplierId = null (transitional, §W-D38)
  { warehouseCode: 'SUP_BOC', warehouseName: '본코스메틱 (BOC)', warehouseType: 'SUPPLIER_SITE' },
  { warehouseCode: 'SUP_IJC', warehouseName: '일진코스메틱', warehouseType: 'SUPPLIER_SITE' },
  { warehouseCode: 'SUP_CSM', warehouseName: '코스메카코리아', warehouseType: 'SUPPLIER_SITE' },
  { warehouseCode: 'SUP_CLB', warehouseName: '갈렙이앤씨', warehouseType: 'SUPPLIER_SITE' },
  { warehouseCode: 'SUP_MKM', warehouseName: '마케모', warehouseType: 'SUPPLIER_SITE' },
  { warehouseCode: 'SUP_EZC', warehouseName: '이지코어', warehouseType: 'SUPPLIER_SITE' },
  { warehouseCode: 'SUP_CTK', warehouseName: '씨티케이', warehouseType: 'SUPPLIER_SITE' },
  { warehouseCode: 'SUP_RBM', warehouseName: '리봄화장품', warehouseType: 'SUPPLIER_SITE' },
  { warehouseCode: 'SUP_JPS', warehouseName: '제이피에스코스메틱', warehouseType: 'SUPPLIER_SITE' },
  { warehouseCode: 'SUP_NNN', warehouseName: '뉴앤뉴', warehouseType: 'SUPPLIER_SITE' },
  { warehouseCode: 'SUP_BON', warehouseName: '본코스메틱 (BON)', warehouseType: 'SUPPLIER_SITE' },

  // 시스템 예약 1곳 — DB partial UNIQUE 가 최대 1행을 강제한다 (§W-D11)
  { warehouseCode: 'IN_TRANSIT', warehouseName: '이동중', warehouseType: 'IN_TRANSIT' },
];

/** 15종 전부 동일한 값 (§W-D37). */
const SEED_COMMON = {
  /**
   * ★ 전부 `null` 이다 (§W-D14). `ExternalSystem` seed 자체가 없어 실재하는
   * 외부시스템을 연결할 수 없다 — ⛔ 이름이 비슷하다는 이유로 추정하지 않는다.
   * 정식 `ExternalSystem` seed 가 landing 하면 별도 linkage task 가 연결한다.
   */
  externalSystemId: null,
  /** ★ 11건의 `SUPPLIER_SITE` 포함 전부 null — Phase 7(`T4-19`)이 채운다. */
  supplierId: null,
  timezone: 'Asia/Seoul',
  address: null,
} as const;

export interface WarehouseSeedResult {
  /** 이번 실행에서 새로 만든 창고 수. 재실행 시 0. */
  readonly created: number;
  /** 이미 있어 건너뛴 창고 수. */
  readonly skipped: number;
  /** 시드 대상 총 개수 — 항상 15. */
  readonly total: number;
}

/**
 * ⚠️ 반드시 `prisma/seed/index.ts` 의 단일 트랜잭션 안에서 호출한다 —
 *    창고와 DEFAULT 로케이션이 부분 시드로 남지 않게 한다.
 * ⛔ AuditLog 를 쓰지 않는다 (§W-D35) — seed 는 deployment/bootstrap 데이터이지
 *    runtime actor mutation 이 아니다.
 */
export async function seedWarehouses(client: WarehouseSeedClient): Promise<WarehouseSeedResult> {
  let created = 0;
  let skipped = 0;

  for (const seed of WAREHOUSE_SEEDS) {
    const existing = await client.warehouse.findUnique({
      where: { warehouseCode: seed.warehouseCode },
      select: { id: true },
    });

    // ★ 이미 있으면 그대로 둔다 — ⛔ 수정·삭제하지 않는다.
    if (existing !== null) {
      skipped += 1;
      continue;
    }

    await insertWarehouseWithDefaultLocation(client as Prisma.TransactionClient, {
      warehouseCode: seed.warehouseCode,
      warehouseName: seed.warehouseName,
      warehouseType: seed.warehouseType,
      ...SEED_COMMON,
    });
    created += 1;
  }

  return { created, skipped, total: WAREHOUSE_SEEDS.length };
}

export function formatWarehouseSeedSummary(result: WarehouseSeedResult): string {
  return `창고 시드 — 총 ${result.total}개 (신규 ${result.created}, 기존 유지 ${result.skipped}), 각 DEFAULT 로케이션 1개`;
}
