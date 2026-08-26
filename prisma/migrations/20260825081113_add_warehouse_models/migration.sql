-- 창고 · 로케이션 (T08-1 = v0.2 T2-1A)
--
-- 근거: docs/19_설계복구_Warehouse.md
--       (2026-08-25 Warehouse Design Recovery Decision — W-D1 ~ W-D42)
--       원 설계는 docs/03_ERD와_Prisma스키마_v0.2.md §6.2(WAREHOUSE ·
--       WAREHOUSE_LOCATION) 및 §고유조건·인덱스의 `warehouse_location` 행.
--
-- T08-1 은 **테이블 · DB 제약 · relation landing 까지만** 만든다.
-- application service(T08-2) · API · DTO · permission · route-policy ·
-- 창고 15종 seed · DEFAULT 자동생성 flow · 화면(T2-20) 은 범위가 아니다.
-- ⛔ 이 migration 은 데이터 행을 하나도 만들지 않는다.
--
-- ── ★ default_location_id 는 NOT NULL 이다 (W-D5) ───────────────────
-- `docs/03` Prisma 블록은 nullable 이었으나 같은 문서 §6.2 ERD 와
-- `docs/00 §2.2 G-05` 가 NOT NULL 을 명시한다 → NOT NULL 이 정본이다.
-- (PRE-FLIGHT 의 nullable 유지 권고는 사용자 검토에서 REJECTED 되었다.)
--
-- ── ★ same-warehouse composite FK (W-D6) ───────────────────────────
-- 단일 `default_location_id → warehouse_location(id)` FK 로는 **다른 창고의**
-- 로케이션을 default 로 지정하는 것을 막을 수 없다. 그래서 2열 FK 를 건다:
--
--     FOREIGN KEY (id, default_location_id)
--     REFERENCES warehouse_location (warehouse_id, id)
--
-- 첫 열이 `warehouse.id = warehouse_location.warehouse_id` 를 강제하므로
-- DEFAULT 로케이션은 **반드시 그 창고 소속**이다. 참조 대상 UNIQUE 는
-- `warehouse_location_warehouse_id_id_key` 이며 ⛔ 삭제하면 FK 가 깨진다.
--
-- ── ★ 순환 참조와 DEFERRABLE (W-D7) ────────────────────────────────
-- warehouse ↔ warehouse_location 은 서로를 참조한다. `default_location_id`
-- 가 NOT NULL 이므로 "창고를 먼저 넣고 나중에 UPDATE" 는 성립하지 않는다
-- (첫 INSERT 가 NOT NULL 을 위반한다). T08-2 의 생성 트랜잭션은
--
--     ① location UUID 를 애플리케이션에서 미리 생성
--     ② warehouse INSERT (default_location_id 를 그 UUID 로 채움)
--     ③ warehouse_location INSERT (location_code = 'DEFAULT')
--     ④ COMMIT 시점에 deferred FK 검증
--
-- 순서로 동작하며 **사후 UPDATE 문이 없다**. 그것이 가능하려면 이 FK 가
-- `DEFERRABLE INITIALLY DEFERRED` 여야 한다. Prisma 는 deferrability 를
-- 표현하지 못하므로 아래에서 명시적으로 그렇게 만든다.
-- ⚠️ 반대 방향(`warehouse_location.warehouse_id`)은 **deferrable 이 아니다** —
--    ②에서 warehouse 가 이미 있으므로 즉시 검사가 가능하고, 즉시 검사가
--    오류를 더 가까운 지점에서 잡아 준다.
--
-- ── ★ Supplier staged link — one-way CHECK 만 (W-D13) ──────────────
--     CHECK (supplier_id IS NULL OR warehouse_type = 'SUPPLIER_SITE')
--
-- `SUPPLIER_SITE` + `supplier_id IS NULL` 은 **허용되는 transitional state**
-- 다. `docs/06 §12.8` 이 창고를 Phase 3 에서, 거래처를 Phase 7 에서 이관한다고
-- 명시하므로 창고 seed 시점에는 연결할 거래처가 존재하지 않는다.
-- ⛔ 역방향 CHECK
--      (warehouse_type <> 'SUPPLIER_SITE' OR supplier_id IS NOT NULL)
--    를 T08 에서 추가하지 않는다 — T08-2 의 SUPPLIER_SITE 11건 seed 가 즉시
--    실패한다. 양방향 IFF 는 11건 backfill 이 끝난 뒤 마이그레이션
--    Phase 7(`T4-19`)이 추가한다 (W-D13 최종 운영 불변식).
-- ⚠️ 반대로 non-SUPPLIER_SITE 에 supplier_id 를 넣는 것은 지금도 거부된다.
--
-- ── ★ IN_TRANSIT 은 시스템 예약 singleton 이다 (W-D11) ─────────────
-- 창고이동 중간 버킷은 전 시스템에 하나뿐이다. 상수식 partial UNIQUE
-- 인덱스로 강제한다 (`(true)` 는 모든 대상 행을 같은 키로 접는다).
--
-- ── staged scalar 5종 → real FK landing (W-D15) ────────────────────
-- T05-1 · T06-1 · T07-1 이 "`Warehouse` 가 없어 FK 를 걸 수 없다" 며 남긴
-- UUID scalar 5개가 여기서 진짜 FK 가 된다:
--      sku_external_mapping.warehouse_id      (docs/12)
--      supplier.default_warehouse_id          (docs/17 §8)
--      supplier_sku.destination_warehouse_id  (docs/17 §14)
--      bom_header.destination_warehouse_id    (docs/18 §D-32)
--      bom_line.issue_warehouse_id            (docs/18 §D-32)
-- 실측상 이 5개 컬럼에 **비어 있지 않은 값이 하나도 없어** 데이터 보정이
-- 필요 없다 (W-D20). ⛔ 이 migration 은 어떤 행도 UPDATE·DELETE 하지 않고
-- placeholder 창고도 만들지 않는다.
--
-- ⛔ T09 재고 모델을 만들지 않는다 — `inventory_ledger_entry` ·
--    `inventory_balance` · 재고키 · PostingService 는 전부 T09 다 (W-D18).
-- ⛔ 창고 15종 · DEFAULT 로케이션 · IN_TRANSIT row 를 넣지 않는다 (T08-2).
-- ⛔ permission · route-policy · seed 를 건드리지 않는다.

-- CreateEnum
CREATE TYPE "WarehouseType" AS ENUM ('INTERNAL', 'THREE_PL', 'SUPPLIER_SITE', 'OVERSEAS', 'VIRTUAL', 'IN_TRANSIT');

-- CreateTable
CREATE TABLE "warehouse" (
    "id" UUID NOT NULL,
    "warehouse_code" VARCHAR(50) NOT NULL,
    "warehouse_name" VARCHAR(150) NOT NULL,
    "warehouse_type" "WarehouseType" NOT NULL,
    "external_system_id" UUID,
    "supplier_id" UUID,
    "default_location_id" UUID NOT NULL,
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'Asia/Seoul',
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_location" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_code" VARCHAR(50) NOT NULL,
    "location_name" VARCHAR(150) NOT NULL,
    "location_type" VARCHAR(30),
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "warehouse_location_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_warehouse_code_key" ON "warehouse"("warehouse_code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_location_warehouse_id_location_code_key" ON "warehouse_location"("warehouse_id", "location_code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_location_warehouse_id_id_key" ON "warehouse_location"("warehouse_id", "id");

-- AddForeignKey
ALTER TABLE "sku_external_mapping" ADD CONSTRAINT "sku_external_mapping_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_default_warehouse_id_fkey" FOREIGN KEY ("default_warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_sku" ADD CONSTRAINT "supplier_sku_destination_warehouse_id_fkey" FOREIGN KEY ("destination_warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_header" ADD CONSTRAINT "bom_header_destination_warehouse_id_fkey" FOREIGN KEY ("destination_warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_line" ADD CONSTRAINT "bom_line_issue_warehouse_id_fkey" FOREIGN KEY ("issue_warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_external_system_id_fkey" FOREIGN KEY ("external_system_id") REFERENCES "external_system"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- ★ DEFERRABLE INITIALLY DEFERRED — 위 "순환 참조" 주석 참조 (W-D7).
--   Prisma 가 만들어 주지 못하는 부분이라 여기서 명시한다. 컬럼·이름·
--   삭제/갱신 동작은 Prisma 가 기대하는 것과 정확히 같다.
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_id_default_location_id_fkey" FOREIGN KEY ("id", "default_location_id") REFERENCES "warehouse_location"("warehouse_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "warehouse_location" ADD CONSTRAINT "warehouse_location_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- raw SQL — Prisma 스키마로 표현할 수 없는 제약
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. NOT-BLANK CHECK — required 문자열 컬럼 ───────────────────────
-- 기존 convention 그대로다 (`supplier_supplier_code_not_blank_check` 등).
-- ⛔ address · location_type 같은 optional 자유서술 컬럼에는 걸지 않는다.
ALTER TABLE "warehouse"
  ADD CONSTRAINT "warehouse_warehouse_code_not_blank_check"
  CHECK (length(btrim("warehouse_code")) > 0);

ALTER TABLE "warehouse"
  ADD CONSTRAINT "warehouse_warehouse_name_not_blank_check"
  CHECK (length(btrim("warehouse_name")) > 0);

ALTER TABLE "warehouse"
  ADD CONSTRAINT "warehouse_timezone_not_blank_check"
  CHECK (length(btrim("timezone")) > 0);

ALTER TABLE "warehouse_location"
  ADD CONSTRAINT "warehouse_location_location_code_not_blank_check"
  CHECK (length(btrim("location_code")) > 0);

ALTER TABLE "warehouse_location"
  ADD CONSTRAINT "warehouse_location_location_name_not_blank_check"
  CHECK (length(btrim("location_name")) > 0);

-- ── 2. CHECK — Supplier staged link (one-way 전용) ──────────────────
-- ★ 방향을 반드시 확인할 것 (W-D13):
--     supplier_id 가 있으면      → warehouse_type 은 SUPPLIER_SITE 여야 한다
--     SUPPLIER_SITE 인데 null    → **허용** (Phase 7 이전 transitional state)
-- ⛔ 역방향 조건을 이 CHECK 에 덧붙이지 않는다.
ALTER TABLE "warehouse"
  ADD CONSTRAINT "warehouse_supplier_site_check"
  CHECK ("supplier_id" IS NULL OR "warehouse_type" = 'SUPPLIER_SITE');

-- ── 3. partial UNIQUE — IN_TRANSIT 창고는 전 시스템에 1개 ───────────
-- 상수식 `(true)` 를 키로 삼아 대상 행 전체를 하나의 키로 접는다.
-- 다른 유형의 창고는 이 인덱스의 대상이 아니므로 개수 제한이 없다.
CREATE UNIQUE INDEX "ux_warehouse_in_transit_singleton"
  ON "warehouse" ((true)) WHERE ("warehouse_type" = 'IN_TRANSIT');
