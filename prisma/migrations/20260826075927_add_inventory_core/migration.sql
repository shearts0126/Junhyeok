-- CreateEnum
CREATE TYPE "InventoryStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'OUTBOUND_PENDING', 'HOLD', 'INSPECTION', 'DEFECTIVE', 'RETURN_PENDING', 'DISPOSAL_PENDING', 'IN_TRANSIT');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('OPENING_BALANCE', 'PURCHASE_RECEIPT', 'PRODUCTION_RECEIPT', 'RETURN_RECEIPT', 'WAREHOUSE_TRANSFER_IN', 'ASSEMBLY_RECEIPT', 'DISASSEMBLY_RECEIPT', 'SALES_SHIPMENT', 'B2B_SHIPMENT', 'MARKETING_SHIPMENT', 'CS_SHIPMENT', 'SAMPLE_SHIPMENT', 'EMPLOYEE_USE', 'VENDOR_RETURN', 'DISPOSAL', 'WAREHOUSE_TRANSFER_OUT', 'ASSEMBLY_CONSUMPTION', 'DISASSEMBLY_CONSUMPTION', 'STATUS_CHANGE', 'STOCK_COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT', 'REVERSAL', 'RESERVATION', 'RESERVATION_RELEASE');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "OutboundPurpose" AS ENUM ('SALES_B2C', 'SALES_B2B', 'WAREHOUSE_REPLENISHMENT', 'MARKETING', 'CS', 'SAMPLE', 'EMPLOYEE_USE', 'OTHER');

-- CreateTable
CREATE TABLE "inventory_transaction" (
    "id" UUID NOT NULL,
    "transaction_no" VARCHAR(50) NOT NULL,
    "transaction_type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'POSTED',
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "business_date" DATE NOT NULL,
    "posted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "imported_at" TIMESTAMPTZ,
    "source_document_type" VARCHAR(50),
    "source_document_id" UUID,
    "source_document_no" VARCHAR(100),
    "external_system_id" UUID,
    "external_transaction_id" VARCHAR(200),
    "idempotency_key" VARCHAR(300),
    "reversal_of_id" UUID,
    "reason_code" VARCHAR(50),
    "reason_detail" TEXT,
    "attachment_group_id" UUID,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_ledger_entry" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "sku_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "inventory_status" "InventoryStatus" NOT NULL,
    "lot_no" VARCHAR(100) NOT NULL DEFAULT '',
    "expiry_key" DATE NOT NULL DEFAULT '9999-12-31'::date,
    "serial_no" VARCHAR(200) NOT NULL DEFAULT '',
    "owner_code" VARCHAR(30) NOT NULL DEFAULT 'DEEPPOINT',
    "expiry_date" DATE,
    "manufactured_date" DATE,
    "quantity_delta" DECIMAL(18,6) NOT NULL,
    "base_uom" VARCHAR(20) NOT NULL,
    "original_quantity" DECIMAL(18,6),
    "original_uom" VARCHAR(20),
    "conversion_factor" DECIMAL(18,6),
    "channel_id" UUID,
    "outbound_purpose" "OutboundPurpose",
    "external_line_id" VARCHAR(200),
    "note" TEXT,
    "business_date" DATE NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balance" (
    "id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "inventory_status" "InventoryStatus" NOT NULL,
    "lot_no" VARCHAR(100) NOT NULL DEFAULT '',
    "expiry_key" DATE NOT NULL DEFAULT '9999-12-31'::date,
    "serial_no" VARCHAR(200) NOT NULL DEFAULT '',
    "owner_code" VARCHAR(30) NOT NULL DEFAULT 'DEEPPOINT',
    "quantity" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "last_transaction_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "lock_version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "inventory_balance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transaction_transaction_no_key" ON "inventory_transaction"("transaction_no");

-- CreateIndex
CREATE INDEX "inventory_transaction_business_date_idx" ON "inventory_transaction"("business_date");

-- CreateIndex
CREATE INDEX "inventory_transaction_transaction_type_business_date_idx" ON "inventory_transaction"("transaction_type", "business_date");

-- CreateIndex
CREATE INDEX "inventory_transaction_source_document_type_source_document__idx" ON "inventory_transaction"("source_document_type", "source_document_id");

-- CreateIndex
CREATE INDEX "inventory_transaction_external_system_id_external_transacti_idx" ON "inventory_transaction"("external_system_id", "external_transaction_id");

-- CreateIndex
CREATE INDEX "inventory_ledger_entry_sku_id_warehouse_id_inventory_status_idx" ON "inventory_ledger_entry"("sku_id", "warehouse_id", "inventory_status", "lot_no", "expiry_key", "serial_no", "owner_code", "business_date");

-- CreateIndex
CREATE INDEX "inventory_ledger_entry_warehouse_id_business_date_idx" ON "inventory_ledger_entry"("warehouse_id", "business_date");

-- CreateIndex
CREATE INDEX "inventory_ledger_entry_business_date_transaction_id_idx" ON "inventory_ledger_entry"("business_date", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_ledger_entry_transaction_id_line_no_key" ON "inventory_ledger_entry"("transaction_id", "line_no");

-- CreateIndex
CREATE INDEX "inventory_balance_sku_id_idx" ON "inventory_balance"("sku_id");

-- CreateIndex
CREATE INDEX "inventory_balance_warehouse_id_inventory_status_idx" ON "inventory_balance"("warehouse_id", "inventory_status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_key" ON "inventory_balance"("sku_id", "warehouse_id", "location_id", "inventory_status", "lot_no", "expiry_key", "serial_no", "owner_code");

-- AddForeignKey
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "inventory_transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_external_system_id_fkey" FOREIGN KEY ("external_system_id") REFERENCES "external_system"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entry" ADD CONSTRAINT "inventory_ledger_entry_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "inventory_transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entry" ADD CONSTRAINT "inventory_ledger_entry_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entry" ADD CONSTRAINT "inventory_ledger_entry_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entry" ADD CONSTRAINT "inventory_ledger_entry_warehouse_id_location_id_fkey" FOREIGN KEY ("warehouse_id", "location_id") REFERENCES "warehouse_location"("warehouse_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_warehouse_id_location_id_fkey" FOREIGN KEY ("warehouse_id", "location_id") REFERENCES "warehouse_location"("warehouse_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_last_transaction_id_fkey" FOREIGN KEY ("last_transaction_id") REFERENCES "inventory_transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════
-- 이하 raw SQL — Prisma 가 표현하지 못하는 승인된 DB 계약 (T2-2).
--
-- 근거: docs/03_ERD와_Prisma스키마_v0.2.md §Layer 3 재고 코어 ★
--       docs/00_요구사항_이해와_충돌검토_v0.2.md C-09 · C-10 · C-14
--
-- ⛔ REVERSAL 재취소 차단(`reject_reversal_of_reversal` /
--    `trg_no_reversal_of_reversal`)은 **T2-3** 소유다 — 여기에 넣지 않는다.
-- ═══════════════════════════════════════════════════════════════════════

-- 조건부 UNIQUE ①: 외부 멱등키 중복 차단.
-- NULL 은 여러 건 허용해야 하므로 partial index 여야 한다 — 일반 UNIQUE 로는
-- 표현할 수 없다(PostgreSQL 이 NULL 을 서로 다른 값으로 취급하긴 하지만,
-- 의도를 명시적으로 남기고 인덱스 크기도 줄인다).
CREATE UNIQUE INDEX "ux_txn_idem"
  ON "inventory_transaction" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

COMMENT ON INDEX "ux_txn_idem" IS
  '외부 거래 멱등키 중복 차단 (T2-2). NULL 은 다중 허용.';

-- 조건부 UNIQUE ②: 동일 거래를 두 번 취소할 수 없다.
-- ★ `status = 'POSTED'` 조건이 핵심이다 — 취소가 다시 REVERSED 되면 그 자리를
--   비워 줘야 하므로 POSTED 인 반대거래만 유일해야 한다.
CREATE UNIQUE INDEX "ux_txn_reversal"
  ON "inventory_transaction" ("reversal_of_id")
  WHERE "reversal_of_id" IS NOT NULL AND "status" = 'POSTED';

COMMENT ON INDEX "ux_txn_reversal" IS
  '한 거래당 POSTED 반대거래 1건 (T2-2, C-14 이중 방어).';

-- CHECK ①: 원인문서 필수. 기초재고는 배치 자체가 근거라 예외다.
ALTER TABLE "inventory_transaction"
  ADD CONSTRAINT "ck_source_doc"
  CHECK (
    "transaction_type" = 'OPENING_BALANCE'
    OR "source_document_type" IS NOT NULL
  );

-- CHECK ②: 개별 원장행은 0 일 수 없다.
-- ⚠️ **개별 entry 기준**이다. 같은 재고키 그룹의 net 합이 0 인 것은 정상이며
--    (예: 상태이동 −10/+10) 그 판정은 posting runtime(T2-6~) 소관이다.
ALTER TABLE "inventory_ledger_entry"
  ADD CONSTRAINT "ck_qty_nonzero"
  CHECK ("quantity_delta" <> 0);

-- 부분 인덱스: 채널별 수불부 조회. channel_id 는 출고 원장행에만 있다.
CREATE INDEX "ix_ledger_channel"
  ON "inventory_ledger_entry" ("channel_id", "business_date")
  WHERE "channel_id" IS NOT NULL;

-- ── 원장 불변성 (INSERT only) ──────────────────────────────────────────
--
-- 애플리케이션 코드만으로 불변성을 보장하지 않는다. psql·관리도구·잘못된
-- 배치에서 직접 실행하는 SQL 도 DB 에서 막아야 원장이 근거가 된다.
-- (T0-7 `audit_log_prevent_modification()` 과 같은 원칙이다.)
--
-- ⛔ 기존 `audit_log_prevent_modification()` 을 재사용하지 않는다 — 예외 메시지가
--    'AUDIT_LOG_IMMUTABLE' 로 고정돼 있어 원장에서 쓰면 잘못된 문구가 나간다.
--    그 함수를 수정하는 것도 금지다(audit_log 트리거 3종이 이미 의존한다).
--
-- ⚠️ PostgreSQL 한계: 테이블 소유자와 superuser 는
--      ALTER TABLE inventory_ledger_entry DISABLE TRIGGER ALL
--    로 트리거를 끌 수 있다. 운영에서는 애플리케이션 롤에 소유권을 주지 않는다.
CREATE OR REPLACE FUNCTION raise_immutable_violation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_VIOLATION';
END;
$$;

COMMENT ON FUNCTION raise_immutable_violation() IS
  '불변 테이블의 UPDATE/DELETE 를 차단한다 (T2-2).';

-- ⛔ TRUNCATE 트리거를 만들지 않는다 — `docs/03` 이 BEFORE UPDATE OR DELETE 만
--    명시한다. 추가 보호가 필요하면 별도 hardening task 에서 판단한다.
CREATE TRIGGER "trg_ledger_immutable"
  BEFORE UPDATE OR DELETE ON "inventory_ledger_entry"
  FOR EACH ROW
  EXECUTE FUNCTION raise_immutable_violation();
