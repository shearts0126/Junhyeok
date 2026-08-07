CREATE TYPE "SkuStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'ACTIVE', 'INACTIVE', 'DISCONTINUED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "sku" (
    "id" UUID NOT NULL,
    "sku_code" VARCHAR(80) NOT NULL,
    "sku_name" VARCHAR(255) NOT NULL,
    "sku_name_en" VARCHAR(255),
    "item_type" VARCHAR(40) NOT NULL,
    "status" "SkuStatus" NOT NULL DEFAULT 'DRAFT',
    "brand_id" UUID,
    "major_category_id" UUID,
    "minor_category_id" UUID,
    "serial_number" VARCHAR(20),
    "additional_code" VARCHAR(30),
    "base_uom" VARCHAR(20) NOT NULL DEFAULT 'EA',
    "purchase_uom" VARCHAR(20),
    "unit_conversion_qty" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "inventory_managed" BOOLEAN NOT NULL DEFAULT true,
    "sellable" BOOLEAN NOT NULL DEFAULT false,
    "purchasable" BOOLEAN NOT NULL DEFAULT false,
    "manufacturable" BOOLEAN NOT NULL DEFAULT false,
    "lot_managed" BOOLEAN NOT NULL DEFAULT false,
    "expiry_managed" BOOLEAN NOT NULL DEFAULT false,
    "serial_managed" BOOLEAN NOT NULL DEFAULT false,
    "default_shelf_life_days" INTEGER,
    "minimum_remaining_days" INTEGER,
    "reconciliation_tolerance_qty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "erp_item_type" VARCHAR(10),
    "has_transaction" BOOLEAN NOT NULL DEFAULT false,
    "discontinuation_date" DATE,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "approved_by" UUID,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "sku_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sku_sku_code_key" ON "sku"("sku_code");

-- CreateIndex
CREATE INDEX "sku_status_idx" ON "sku"("status");

-- CreateIndex
CREATE INDEX "sku_item_type_idx" ON "sku"("item_type");

-- CreateIndex
CREATE INDEX "sku_brand_id_major_category_id_minor_category_id_idx" ON "sku"("brand_id", "major_category_id", "minor_category_id");

-- AddForeignKey
ALTER TABLE "sku" ADD CONSTRAINT "sku_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "common_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku" ADD CONSTRAINT "sku_major_category_id_fkey" FOREIGN KEY ("major_category_id") REFERENCES "common_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku" ADD CONSTRAINT "sku_minor_category_id_fkey" FOREIGN KEY ("minor_category_id") REFERENCES "common_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku" ADD CONSTRAINT "sku_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku" ADD CONSTRAINT "sku_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku" ADD CONSTRAINT "sku_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════
-- CHECK 제약 (수기 추가 — Prisma 스키마 언어는 CHECK 를 표현하지 못함)
--
-- ⛔ sku_code 패턴 CHECK 는 걸지 않는다 — 원본에 코드체계 예외 SKU 가 실존한다.
--    패턴 위반은 후속 validation/import 의 WARNING, DB 는 NOT BLANK·TRIM·
--    GLOBAL UNIQUE 까지만 보장한다.
-- ═══════════════════════════════════════════════════════════════

-- 필수 문자열은 빈 값·앞뒤 공백 금지 (T0-8 convention)
ALTER TABLE "sku"
  ADD CONSTRAINT "sku_code_not_blank_check"
  CHECK (length("sku_code") > 0 AND "sku_code" = btrim("sku_code"));

ALTER TABLE "sku"
  ADD CONSTRAINT "sku_name_not_blank_check"
  CHECK (length("sku_name") > 0 AND "sku_name" = btrim("sku_name"));

ALTER TABLE "sku"
  ADD CONSTRAINT "sku_item_type_not_blank_check"
  CHECK (length("item_type") > 0 AND "item_type" = btrim("item_type"));

ALTER TABLE "sku"
  ADD CONSTRAINT "sku_base_uom_not_blank_check"
  CHECK (length("base_uom") > 0 AND "base_uom" = btrim("base_uom"));

-- 수량·기간 범위
ALTER TABLE "sku"
  ADD CONSTRAINT "sku_unit_conversion_qty_positive_check"
  CHECK ("unit_conversion_qty" > 0);

ALTER TABLE "sku"
  ADD CONSTRAINT "sku_default_shelf_life_days_check"
  CHECK ("default_shelf_life_days" IS NULL OR "default_shelf_life_days" >= 0);

ALTER TABLE "sku"
  ADD CONSTRAINT "sku_minimum_remaining_days_check"
  CHECK ("minimum_remaining_days" IS NULL OR "minimum_remaining_days" >= 0);

ALTER TABLE "sku"
  ADD CONSTRAINT "sku_reconciliation_tolerance_qty_check"
  CHECK ("reconciliation_tolerance_qty" >= 0);
