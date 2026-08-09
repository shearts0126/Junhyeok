-- SKU 바코드 (T04-1)
--
-- 설계 문서 docs/03_ERD와_Prisma스키마.md §Layer 1(SKU_BARCODE) 및
-- §고유조건·인덱스(Layer 1·2) 의 `sku_barcode` 행.
--
-- T04-1 은 **테이블과 DB 제약까지만** 만든다.
-- 정규화(T04-2)·CRUD API(T04-3)·중복 예외 승인(T04-4)은 이 migration 범위가 아니다.
--
-- ⛔ `deleted_at` 컬럼이 없다 — 삭제 대신 `status = 'INACTIVE'` 다.
-- ⛔ 적용기간 overlap 제약과 `effective_from <= effective_to` CHECK 를 두지 않는다.
--    authoritative 문서에 해당 요구가 없다 (CRUD 단계에서 정책 확인 후 결정).
-- ⛔ `status IN ('ACTIVE','INACTIVE')` allowlist CHECK 를 두지 않는다 —
--    본 프로젝트에는 String 컬럼에 열거값 CHECK 를 거는 convention 이 없다
--    (`sku.item_type` 도 VARCHAR + not-blank CHECK 만 있다).

-- CreateEnum
CREATE TYPE "BarcodeType" AS ENUM ('UNIT', 'INNER_BOX', 'OUTER_BOX', 'CHANNEL', 'LEGACY');

-- CreateTable
CREATE TABLE "sku_barcode" (
    "id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "barcode" VARCHAR(100) NOT NULL,
    "barcode_type" "BarcodeType" NOT NULL DEFAULT 'UNIT',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "country_code" VARCHAR(10),
    "channel_code" VARCHAR(30),
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "duplicate_exception" BOOLEAN NOT NULL DEFAULT false,
    "exception_reason" TEXT,
    "approved_by" UUID,
    "effective_from" DATE,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sku_barcode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sku_barcode_sku_id_idx" ON "sku_barcode"("sku_id");

-- CreateIndex
CREATE INDEX "sku_barcode_barcode_idx" ON "sku_barcode"("barcode");

-- AddForeignKey
-- SKU 는 물리삭제 대상이 아니다 — 바코드가 딸려 물리삭제되면 안 되므로 RESTRICT (CASCADE 금지).
ALTER TABLE "sku_barcode" ADD CONSTRAINT "sku_barcode_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- 승인 actor FK 는 마스터 테이블의 기존 정책(`sku.approved_by`)과 동일한 SET NULL 이다.
-- (`audit_log.approved_by` 의 RESTRICT 는 감사증적 전용 별도 정책이다.)
ALTER TABLE "sku_barcode" ADD CONSTRAINT "sku_barcode_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════
-- 조건부 UNIQUE 2종 (수기 추가 — Prisma 스키마 언어는 partial index 를 표현하지 못함)
--
-- ★ 두 규칙은 **서로 다른 규칙**이며 하나의 composite unique 로 합치지 않는다.
--    - ux_barcode_active  : 바코드 **값 자체**의 전역 활성 중복
--    - ux_barcode_primary : **한 SKU 안**의 활성 대표 바코드 개수
-- ═══════════════════════════════════════════════════════════════

-- 조건부 UNIQUE #1 — 활성 일반 바코드.
-- ACTIVE + duplicate_exception=false 인 동일 barcode 는 2개 이상 존재할 수 없다.
-- INACTIVE 이력, 또는 duplicate_exception=true 인 행은 predicate 밖이라 제외된다.
-- (duplicate_exception=true 를 누가·어떻게 만들 수 있는지는 T04-4 범위다.)
CREATE UNIQUE INDEX "ux_barcode_active"
  ON "sku_barcode"("barcode")
  WHERE "status" = 'ACTIVE' AND "duplicate_exception" = false;

-- 조건부 UNIQUE #2 — SKU 당 활성 대표 1개.
-- 동일 SKU 에 ACTIVE + is_primary=true 인 바코드는 최대 1개. INACTIVE 대표 이력은 허용된다.
CREATE UNIQUE INDEX "ux_barcode_primary"
  ON "sku_barcode"("sku_id")
  WHERE "is_primary" = true AND "status" = 'ACTIVE';


-- ═══════════════════════════════════════════════════════════════
-- CHECK 제약 — NOT NULL 문자열 not-blank convention (T0-8 이후 전 migration 공통)
--
-- ⚠️ 값을 변환하지 않는다. 빈 값·앞뒤 공백을 **거부**할 뿐이다.
--    바코드 정규화(공백·하이픈 제거, 지수표기 판정)는 T04-2 다.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE "sku_barcode"
  ADD CONSTRAINT "sku_barcode_barcode_not_blank_check"
  CHECK (length("barcode") > 0 AND "barcode" = btrim("barcode"));

ALTER TABLE "sku_barcode"
  ADD CONSTRAINT "sku_barcode_status_not_blank_check"
  CHECK (length("status") > 0 AND "status" = btrim("status"));
