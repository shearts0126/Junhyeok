-- 거래처 · 공급조건 · 가격이력 (T06-1)
--
-- 근거: docs/17_설계복구_거래처공급조건.md
--       (2026-08-12 Supplier / SupplierSku / SupplierSkuPrice Design Recovery
--        Decision — D-1 ~ D-25)
--       원 설계는 docs/03_ERD와_Prisma스키마.md §Layer 1(SUPPLIER ·
--       SUPPLIER_SKU · SUPPLIER_SKU_PRICE) 및 §고유조건·인덱스의
--       `supplier_sku` / `supplier_sku_price` 행.
--
-- T06-1 은 **테이블과 DB 제약까지만** 만든다.
-- 공급조건 API(T06-2)·가격이력/승인 API(T06-3)·거래처 화면(T06-4)은 범위가 아니다.
-- permission·seed·UI·AuditLog producer 도 만들지 않는다.
--
-- ── 적용기간 semantics ───────────────────────────────────────────────
-- `supplier_sku` · `supplier_sku_price` 의 적용기간은 **half-open** 이다:
--
--     [effective_from, effective_to)
--
--   - `effective_from` 포함 / `effective_to` **미포함**
--   - `effective_to IS NULL` = 무기한(open-ended upper bound)
--   - 따라서 `~2026-02-01` 과 `2026-02-01~` 은 **겹치지 않는다**
--     (같은 날 이전 조건 종료 + 새 조건 시작 허용)
--   - zero-length(`effective_to = effective_from`)는 금지한다
--
-- ── EXCLUDE 를 supplier_sku 에만 거는 이유 ───────────────────────────
-- backlog T06-1 완료조건 `적용기간 중첩 차단` 은 **공급조건**에 대한 요구다
-- (`07_개발백로그와_테스트전략_v0.2.md:187` "적용기간 중첩 **공급조건** 차단").
-- 기존 `UNIQUE(supplier_id, sku_id, effective_from)` 은 동일 시작일만 막고
-- interval overlap(부분중첩·포함·open-ended)은 통과시키므로 완료조건에 미달한다.
-- → `EXCLUDE USING gist` 로 DB 가 막는다. application validation 으로 대체하지 않는다.
--
-- ⛔ `supplier_sku_price` 에는 EXCLUDE 를 걸지 않는다 — 가격이력의 계약이 다르다.
--    docs/05 §10.6 가격 등록 행은 "**적용일 중복** 차단 / 이전 가격 `effectiveTo`
--    **자동 마감**" 이다. 즉 겹침은 UNIQUE + 등록 트랜잭션의 자동 마감으로 막으며,
--    자동 마감은 T06-3 application 의 몫이다. 여기서 EXCLUDE 를 걸면 아직 없는
--    T06-3 계약을 DB 가 선점하게 된다.
--
-- ── is_primary 정확한 predicate ──────────────────────────────────────
--     UNIQUE (sku_id) WHERE is_primary = true AND effective_to IS NULL
--   - **현재 미종료** 행 중 SKU 당 대표 1개
--   - 종료된 과거 primary 는 새 primary 를 막지 않는다
--     (`ux_external_mapping_primary` 는 predicate 에 effective_to 가 없어 반대로
--      동작한다 — 복사하지 말 것. `ux_barcode_primary` 의 status 조건과도 다르다)
--   - ⚠️ 시작일이 미래여도 `effective_to IS NULL` 이면 대상이다. 원 predicate 에
--     `effective_from <= today` 가 없어 그대로 채택했고 그 한계를 수용한다.
--
-- ── staged scalar (FK 없음 — 의도된 상태) ────────────────────────────
-- ⛔ 아래 3개는 컬럼만 만들고 **FK 를 걸지 않는다**. 참조 테이블이 아직 없다.
--      supplier.default_warehouse_id            → warehouse (T08-1)
--      supplier_sku.destination_warehouse_id    → warehouse (T08-1)
--      supplier_sku_price.attachment_id         → attachment (미배정 future)
--    `sku_external_mapping.warehouse_id`(T05-1)와 동일한 staged 패턴이다.
--    임의 UUID 가 들어가도 위반이 나지 않으며 이는 사고가 아니다.
--    T08-1 / Attachment 구현 시 FK·relation 을 함께 추가한다.
--
-- ⛔ `SupplierType` / `SupplierStatus` enum 을 만들지 않는다 — 원 선언이 String
--    이고 주석의 값들은 예시다. 열거값 allow-list CHECK 도 걸지 않는다
--    (`external_system.system_type` 과 동일한 판단).
-- ⛔ `unit_conversion_qty` 를 넣지 않는다 — docs/03 ERD 블록에만 있고
--    authoritative Prisma 블록에는 없다.
-- ⛔ `approval_status` · `approved_at` 컬럼을 만들지 않는다 —
--    승인 상태는 `approved_by` 의 NULL 여부로 표현한다.
-- ⛔ 감사 트리거를 만들지 않는다 — 감사로그는 Application Service 가 명시 호출한다.

-- CreateEnum
CREATE TYPE "SupplyType" AS ENUM ('SELF_SUPPLIED', 'TURNKEY');

-- CreateTable
CREATE TABLE "supplier" (
    "id" UUID NOT NULL,
    "supplier_code" VARCHAR(50) NOT NULL,
    "supplier_name" VARCHAR(150) NOT NULL,
    "supplier_type" VARCHAR(30) NOT NULL,
    "business_registration_no" VARCHAR(30),
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "default_lead_time_days" INTEGER,
    "default_warehouse_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_sku" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "supplier_sku_code" VARCHAR(100),
    "supplier_sku_name" VARCHAR(255),
    "supply_type" "SupplyType" NOT NULL DEFAULT 'SELF_SUPPLIED',
    "moq" DECIMAL(18,6),
    "order_multiple" DECIMAL(18,6),
    "lead_time_days" INTEGER,
    "purchase_uom" VARCHAR(20),
    "destination_warehouse_id" UUID,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'KRW',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_sku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_sku_price" (
    "id" UUID NOT NULL,
    "supplier_sku_id" UUID NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'KRW',
    "vat_included" BOOLEAN NOT NULL DEFAULT false,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "source_document" VARCHAR(255),
    "attachment_id" UUID,
    "created_by" UUID,
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_sku_price_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_supplier_code_key" ON "supplier"("supplier_code");

-- CreateIndex
CREATE INDEX "supplier_sku_sku_id_idx" ON "supplier_sku"("sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_sku_supplier_id_sku_id_effective_from_key" ON "supplier_sku"("supplier_id", "sku_id", "effective_from");

-- CreateIndex
CREATE INDEX "supplier_sku_price_supplier_sku_id_effective_from_idx" ON "supplier_sku_price"("supplier_sku_id", "effective_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_sku_price_supplier_sku_id_effective_from_key" ON "supplier_sku_price"("supplier_sku_id", "effective_from");

-- AddForeignKey
ALTER TABLE "supplier_sku" ADD CONSTRAINT "supplier_sku_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_sku" ADD CONSTRAINT "supplier_sku_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_sku_price" ADD CONSTRAINT "supplier_sku_price_supplier_sku_id_fkey" FOREIGN KEY ("supplier_sku_id") REFERENCES "supplier_sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_sku_price" ADD CONSTRAINT "supplier_sku_price_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_sku_price" ADD CONSTRAINT "supplier_sku_price_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════
-- Prisma 스키마로 표현할 수 없는 제약 (raw SQL)
--   1) NOT-BLANK CHECK        — required 문자열 컬럼
--   2) 범위 CHECK             — 리드타임 · 수량 · 적용기간
--   3) 조건부 UNIQUE          — 현행 대표 공급조건
--   4) EXCLUDE (btree_gist)   — 공급조건 적용기간 중첩 차단
-- ═══════════════════════════════════════════════════════════════

-- ── 1. NOT-BLANK ────────────────────────────────────────────────
-- required 문자열에 빈 문자열·공백만 있는 값이 들어가는 것을 막는다
-- (`sku_code_not_blank_check` 등 기존 convention).
-- ⛔ email·phone·사업자번호·note 에는 추가 CHECK 를 두지 않는다.

ALTER TABLE "supplier"
  ADD CONSTRAINT "supplier_supplier_code_not_blank_check"
  CHECK (length(btrim("supplier_code")) > 0);

ALTER TABLE "supplier"
  ADD CONSTRAINT "supplier_supplier_name_not_blank_check"
  CHECK (length(btrim("supplier_name")) > 0);

-- ★ 값 목록을 제한하지 않는다 — structural integrity(blank)만 본다.
ALTER TABLE "supplier"
  ADD CONSTRAINT "supplier_supplier_type_not_blank_check"
  CHECK (length(btrim("supplier_type")) > 0);

ALTER TABLE "supplier"
  ADD CONSTRAINT "supplier_status_not_blank_check"
  CHECK (length(btrim("status")) > 0);

-- ★ ISO 4217 allow-list·uppercase 강제를 하지 않는다.
ALTER TABLE "supplier_sku"
  ADD CONSTRAINT "supplier_sku_currency_not_blank_check"
  CHECK (length(btrim("currency")) > 0);

ALTER TABLE "supplier_sku_price"
  ADD CONSTRAINT "supplier_sku_price_currency_not_blank_check"
  CHECK (length(btrim("currency")) > 0);

-- ── 2. 범위 CHECK ───────────────────────────────────────────────
-- ★ 리드타임: NULL(미입력/미확정)과 0(명시적 즉시납)은 **다른 값**이다.
--   §00 G-03 은 "null 을 0 으로 대체 금지" 이지 "0 입력 금지" 가 아니므로
--   0 을 막지 않는다. 음수만 막는다. DB default 도 두지 않는다.

ALTER TABLE "supplier"
  ADD CONSTRAINT "supplier_default_lead_time_days_check"
  CHECK ("default_lead_time_days" IS NULL OR "default_lead_time_days" >= 0);

ALTER TABLE "supplier_sku"
  ADD CONSTRAINT "supplier_sku_lead_time_days_check"
  CHECK ("lead_time_days" IS NULL OR "lead_time_days" >= 0);

-- ★ 수량: NULL 이 미지정이다. 0 을 "미지정" 대용으로 쓰지 않기 위해
--   값이 있으면 **0 보다 커야** 한다 (리드타임과 규칙이 다르다).
ALTER TABLE "supplier_sku"
  ADD CONSTRAINT "supplier_sku_moq_positive_check"
  CHECK ("moq" IS NULL OR "moq" > 0);

ALTER TABLE "supplier_sku"
  ADD CONSTRAINT "supplier_sku_order_multiple_positive_check"
  CHECK ("order_multiple" IS NULL OR "order_multiple" > 0);

-- ★ 적용기간: half-open 이므로 종료일은 시작일보다 **커야** 한다.
--   `>=` 가 아니다 — `from = to` 는 길이 0 구간이라 아무 날도 포함하지 않는다.
ALTER TABLE "supplier_sku"
  ADD CONSTRAINT "supplier_sku_effective_period_check"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

ALTER TABLE "supplier_sku_price"
  ADD CONSTRAINT "supplier_sku_price_effective_period_check"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

-- ── 3. 조건부 UNIQUE — 현행 대표 공급조건 ───────────────────────
-- SKU 당 **현재 미종료** 대표 1개. predicate 는 docs/03 §고유조건 원문 그대로다.
-- ⛔ `effective_from <= CURRENT_DATE` 를 추가하지 않는다 (문서에 없다).
CREATE UNIQUE INDEX "ux_supplier_sku_primary_current"
  ON "supplier_sku"("sku_id")
  WHERE "is_primary" = true
    AND "effective_to" IS NULL;

-- ── 4. EXCLUDE — 공급조건 적용기간 중첩 차단 ────────────────────
-- 이 프로젝트에서 `btree_gist` 를 도입하는 **첫 사례**다.
-- uuid 등가비교(`WITH =`)를 daterange 중첩(`WITH &&`)과 한 GiST 인덱스에 함께
-- 넣어야 하므로 이 확장이 필수다. application fallback 으로 대체하지 않는다.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- `daterange(from, to, '[)')` — to 는 미포함, NULL 이면 unbounded upper bound.
-- 이 하나로 부분중첩 · 완전포함 · open-ended 중첩 · 동일 시작일이 전부 막히고,
-- 경계가 맞닿는 기간(`~02-01` 과 `02-01~`)은 허용된다.
ALTER TABLE "supplier_sku"
  ADD CONSTRAINT "supplier_sku_effective_period_excl"
  EXCLUDE USING gist (
    "supplier_id" WITH =,
    "sku_id" WITH =,
    daterange("effective_from", "effective_to", '[)') WITH &&
  );
