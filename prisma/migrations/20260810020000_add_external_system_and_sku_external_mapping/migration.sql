-- 외부시스템 · SKU 외부 상품 매핑 (T05-1)
--
-- 근거: docs/12_설계복구_외부상품매핑스키마.md
--       (2026-08-10 External Mapping Schema Design Recovery Decision)
--       원 설계는 docs/03_ERD와_Prisma스키마.md §Layer 1(EXTERNAL_SYSTEM ·
--       SKU_EXTERNAL_MAPPING) 및 §고유조건·인덱스의 `sku_external_mapping` 행.
--
-- T05-1 은 **테이블과 DB 제약까지만** 만든다.
-- 매핑 CRUD API(T05-2)·SKU 해석 서비스(T05-3)·매핑 화면(T05-4)은 범위가 아니다.
--
-- ⛔ `warehouse_id` 는 컬럼만 만들고 **FK 를 걸지 않는다** — `warehouse` 테이블이
--    아직 없다(T08-1). 컬럼을 지금 보존하는 이유는 원 설계에 명시된 3PL scope 이기
--    때문이며, FK·relation 은 T08-1 에서 함께 추가하는 후속 의존사항이다.
-- ⛔ `external_inventory_snapshot` 을 만들지 않는다 — T17-1 의 선행조건이 T05-1 이라
--    여기서 먼저 만들면 의존이 역전된다.
-- ⛔ `external_product_code` 에 not-blank/trim CHECK 를 두지 않는다 —
--    아래 `ux_external_mapping_code` predicate 가 빈 문자열을 명시적으로 제외 대상으로
--    삼으므로, 빈 문자열을 금지하면 authoritative 설계와 모순이다.
-- ⛔ 적용기간 CHECK(`effective_from <= effective_to`)·overlap EXCLUDE 를 두지 않는다 —
--    authoritative 문서에 해당 요구가 없다.
-- ⛔ `external_system` 에 감사 컬럼(created_at 등)을 두지 않는다 — 모델별 명시 선언이
--    일반 ERD 감사 컬럼 규약보다 우선한다는 Recovery Decision (T04-1 과 동일 원칙).

-- CreateEnum
CREATE TYPE "MappingStatus" AS ENUM ('MATCHED', 'UNMATCHED', 'REVIEW_REQUIRED');

-- CreateTable
CREATE TABLE "external_system" (
    "id" UUID NOT NULL,
    "system_code" VARCHAR(50) NOT NULL,
    -- ★ 길이 제한 없음(TEXT). 원 선언이 Prisma `String` 이다 — 임의 VARCHAR 금지.
    "system_name" TEXT NOT NULL,
    -- ★ ERP / WMS / THREE_PL / CHANNEL 은 **예시**다. enum 이 아니다.
    "system_type" VARCHAR(30) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "external_system_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_external_mapping" (
    "id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "external_system_id" UUID NOT NULL,
    -- ★ T05-1 staged state — 컬럼만 존재하고 FK 가 없다 (T08-1 에서 추가).
    "warehouse_id" UUID,
    "external_product_code" VARCHAR(150),
    -- ★ 외부 원문명. 내부 표준 상품명(sku.sku_name)을 덮어쓰지 않는다 (PRD §38).
    "external_product_name" VARCHAR(500),
    "external_barcode" VARCHAR(100),
    "mapping_status" "MappingStatus" NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "effective_from" DATE,
    "effective_to" DATE,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sku_external_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sku_external_mapping_sku_id_idx" ON "sku_external_mapping"("sku_id");

-- CreateIndex
CREATE INDEX "sku_external_mapping_external_system_id_mapping_status_idx" ON "sku_external_mapping"("external_system_id", "mapping_status");

-- CreateIndex
-- ★ 백로그 완료조건 "동일 시스템 코드 중복 차단" 은 이 **전역 UNIQUE** 가 담당한다.
--   아래의 조건부 UNIQUE 2종과 혼동하지 않는다.
CREATE UNIQUE INDEX "external_system_system_code_key" ON "external_system"("system_code");

-- AddForeignKey
-- 마스터는 물리삭제 대상이 아니다 — 매핑이 딸려 지워지면 안 되므로 RESTRICT (CASCADE 금지).
ALTER TABLE "sku_external_mapping" ADD CONSTRAINT "sku_external_mapping_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_external_mapping" ADD CONSTRAINT "sku_external_mapping_external_system_id_fkey" FOREIGN KEY ("external_system_id") REFERENCES "external_system"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════
-- 조건부 UNIQUE 2종 (수기 추가 — Prisma 스키마 언어는 partial index 를 표현하지 못함)
--
-- ★ 두 규칙은 **서로 다른 규칙**이며 하나의 composite unique 로 합치지 않는다.
--    - ux_external_mapping_code    : **현행(미종료)** 매핑의 시스템별 외부코드 중복
--    - ux_external_mapping_primary : SKU × 외부시스템당 대표 매핑 개수
-- ═══════════════════════════════════════════════════════════════

-- 조건부 UNIQUE #1 — 현행 외부코드.
--
-- ★ predicate 는 authoritative 원문 그대로다.
--   `external_product_code IS NOT NULL` 을 **추가하지 않는다** — PostgreSQL 에서
--   `NULL <> ''` 는 NULL 이고 partial index predicate 는 TRUE 인 행만 담으므로
--   NULL 은 이미 대상에서 제외된다. 원문을 불필요하게 재작성하지 않는다.
--   빈 문자열('')도 `<> ''` 에 의해 제외되므로 동일 시스템에 여러 건 존재할 수 있다.
--   종료된 매핑(effective_to IS NOT NULL)은 이력이므로 제외된다.
CREATE UNIQUE INDEX "ux_external_mapping_code"
  ON "sku_external_mapping"("external_system_id", "external_product_code")
  WHERE "external_product_code" <> ''
    AND "effective_to" IS NULL;

-- 조건부 UNIQUE #2 — SKU × 외부시스템당 대표 매핑 1개.
--
-- ⛔ `AND effective_to IS NULL` 을 추가하지 않는다 — 문서에 없다.
--    `sku_barcode` 의 primary predicate(`AND status='ACTIVE'`)를 복사하지 않는다.
--    따라서 종료된 과거 매핑이 is_primary=true 로 남아 있으면 새 대표를 막는다.
--    이 semantics 를 바꾸는 것은 T05-2(매핑 종료·대표 변경) 설계의 몫이다.
CREATE UNIQUE INDEX "ux_external_mapping_primary"
  ON "sku_external_mapping"("sku_id", "external_system_id")
  WHERE "is_primary" = true;
