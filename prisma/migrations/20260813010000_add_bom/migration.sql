-- BOM — 헤더 · 라인 (T07-1)
--
-- 근거: docs/18_설계복구_BOM.md
--       (2026-08-13 BOM Design Recovery Decision — D-1 ~ D-32)
--       원 설계는 docs/03_ERD와_Prisma스키마_v0.2.md §Layer 2(BOM_HEADER ·
--       BOM_LINE) 및 §고유조건·인덱스의 `bom_header` / `bom_line` 행.
--
-- T07-1 은 **테이블과 DB 제약까지만** 만든다. 도메인(T07-2)·CRUD API(T07-3)·
-- 소요량(T07-4)·워크플로(T07-5)·전개(T07-6)·원가(T07-7)·화면(T07-8)은 범위가
-- 아니다. permission·seed·route-policy·UI·AuditLog producer 도 만들지 않는다.
--
-- ── 적용기간 semantics ───────────────────────────────────────────────
-- `bom_header` 의 적용기간은 **half-open** 이다:
--
--     [effective_from, effective_to)
--
--   - `effective_from` 포함 / `effective_to` **미포함**
--   - `effective_to IS NULL` = 무기한(open-ended upper bound)
--   - 따라서 `~2027-01-01` 과 `2027-01-01~` 은 **겹치지 않는다**
--     (같은 날 구 버전 마감 + 새 버전 시작 허용 — docs/18 §D-5·§D-7)
--   - zero-length(`effective_to = effective_from`)는 금지한다
--
-- ── ★ EXCLUDE 가 ACTIVE 에만 걸리는 이유 (SupplierSku 와 다르다) ─────
-- `supplier_sku` 의 EXCLUDE 는 status 조건이 **없어** 모든 행의 기간 중첩을
-- 막는다. `bom_header` 는 `WHERE (status = 'ACTIVE')` 다 — 원 설계
-- (`03v2:903`)가 그렇고, 그래야 여러 후보 버전(DRAFT·PENDING_APPROVAL·
-- APPROVED)을 같은 기간으로 동시에 준비할 수 있다 (docs/18 §D-5).
-- ⛔ SupplierSku EXCLUDE semantics 를 복사하지 말 것.
--
-- ★ `ACTIVE` 는 "지금 유효"가 아니라 **"적용기간이 발효 승인됨"** 이다.
--   버전 교체는 predecessor 의 `status` 를 바꾸지 않고 `effective_to` 를
--   마감한다 (docs/18 §D-7). 그 chain mutation 은 **T07-5 application** 이며
--   ⛔ DB trigger 로 구현하지 않는다.
--
-- ── ★ alternate_group NULL 중복 문제 ────────────────────────────────
-- 원 설계 `UNIQUE(bom_header_id, component_sku_id, alternate_group)` 은
-- `alternate_group` 이 nullable 이라 **NULL 중복을 전혀 막지 못한다**
-- (PostgreSQL 은 UNIQUE 에서 NULL 을 서로 다른 값으로 취급한다). 실측상
-- 383행 전량 NULL 이므로(`01 §2.3` "대체 부자재 미관리") 완료조건 "중복 라인
-- 차단"(`05:122`)에 미달한다.
-- → `COALESCE(alternate_group, '')` **표현식 UNIQUE** 로 구현한다 (docs/18 §D-3).
--   `NULLS NOT DISTINCT` 는 `00 §C-09` 의 기존 결정에 따라 쓰지 않으며,
--   센티넬 정규화는 C-09 자신이 채택한 방식(`lot_no=''`)과 같다.
--   ⚠️ 센티넬 `''` 은 **인덱스 전용**이다 — 컬럼을 NOT NULL DEFAULT '' 로 바꾸지
--   않고, `alternate_group = ''` 인 행을 만들지도 않는다(blank→null 정규화는
--   T07-3 DTO 의 몫이다).
--
-- ── staged scalar (FK 없음 — 의도된 상태) ────────────────────────────
-- ⛔ 아래 2개는 컬럼만 만들고 **FK 를 걸지 않는다**. 참조 테이블이 아직 없다.
--      bom_header.destination_warehouse_id → warehouse (T08-1)
--      bom_line.issue_warehouse_id         → warehouse (T08-1)
--    `supplier_sku.destination_warehouse_id`(T06-1)와 동일한 staged 패턴이다.
--    임의 UUID 가 들어가도 위반이 나지 않으며 이는 사고가 아니다.
--
-- ⛔ Attachment 컬럼을 만들지 않는다 — BOM scope 0 (docs/18 §D-32).
-- ⛔ 순환(cycle) 방지를 DB 로 구현하지 않는다 — 불가능하며 T07-2 의 DFS +
--    `BOM_CYCLE_GRAPH` advisory lock 이 담당한다 (docs/18 §D-13·§D-28).
-- ⛔ 상태 전이·소요량 정합·UOM 일치·구성품 자격 CHECK 를 만들지 않는다 —
--    전부 application semantics 다 (docs/18 §D-6·§D-10·§D-11·§D-12).
-- ⛔ legacy BOM(80 헤더 / 383 라인) 이관을 이 migration 에 섞지 않는다 —
--    R1a-4 `T4-19` / Phase 8 이다.
--
-- ⚠️ `btree_gist` 는 T06-1(20260812010000)이 이미 설치했다. 재설치하지 않는다.

-- CreateEnum
CREATE TYPE "BomStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'APPROVED', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BomType" AS ENUM ('MANUFACTURING', 'KIT', 'REPACK');

-- CreateEnum
CREATE TYPE "ComponentRole" AS ENUM ('PRODUCT', 'MATERIAL', 'PACKAGING', 'SERVICE');

-- CreateEnum
CREATE TYPE "QuantityStatus" AS ENUM ('CONFIRMED', 'SUGGESTED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "bom_header" (
    "id" UUID NOT NULL,
    "parent_sku_id" UUID NOT NULL,
    "bom_type" "BomType" NOT NULL,
    "version" VARCHAR(20) NOT NULL,
    "status" "BomStatus" NOT NULL DEFAULT 'DRAFT',
    "output_qty" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "output_uom" VARCHAR(20) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "production_partner_id" UUID,
    "destination_warehouse_id" UUID,
    "overall_loss_rate" DECIMAL(8,6),
    "description" TEXT,
    "change_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "approved_by" UUID,
    "activated_at" TIMESTAMPTZ,

    CONSTRAINT "bom_header_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_line" (
    "id" UUID NOT NULL,
    "bom_header_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "component_sku_id" UUID NOT NULL,
    "quantity_per" DECIMAL(18,6),
    "quantity_status" "QuantityStatus" NOT NULL DEFAULT 'UNKNOWN',
    "uom" VARCHAR(20) NOT NULL,
    "loss_rate" DECIMAL(8,6),
    "component_role" "ComponentRole" NOT NULL,
    "supply_type" "SupplyType",
    "alternate_group" VARCHAR(50),
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "issue_warehouse_id" UUID,
    "pack_quantity" DECIMAL(18,6),
    "specification" TEXT,
    "legacy_bom_code" VARCHAR(100),
    "legacy_common_bom_code" VARCHAR(100),
    "note" TEXT,

    CONSTRAINT "bom_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bom_header_parent_sku_id_status_idx" ON "bom_header"("parent_sku_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bom_header_parent_sku_id_version_key" ON "bom_header"("parent_sku_id", "version");

-- CreateIndex
CREATE INDEX "bom_line_component_sku_id_idx" ON "bom_line"("component_sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "bom_line_bom_header_id_line_no_key" ON "bom_line"("bom_header_id", "line_no");

-- AddForeignKey
ALTER TABLE "bom_header" ADD CONSTRAINT "bom_header_parent_sku_id_fkey" FOREIGN KEY ("parent_sku_id") REFERENCES "sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_header" ADD CONSTRAINT "bom_header_production_partner_id_fkey" FOREIGN KEY ("production_partner_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_header" ADD CONSTRAINT "bom_header_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_header" ADD CONSTRAINT "bom_header_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_line" ADD CONSTRAINT "bom_line_bom_header_id_fkey" FOREIGN KEY ("bom_header_id") REFERENCES "bom_header"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_line" ADD CONSTRAINT "bom_line_component_sku_id_fkey" FOREIGN KEY ("component_sku_id") REFERENCES "sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- raw SQL — Prisma 스키마로 표현할 수 없는 제약
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. CHECK — 적용기간 유효성 ──────────────────────────────────────
-- `effective_to` 는 있으면 반드시 `effective_from` **초과**여야 한다.
-- zero-length(같은 날)와 역전 구간을 함께 막는다 (T06-1 선례와 동일).
ALTER TABLE "bom_header"
  ADD CONSTRAINT "bom_header_effective_period_check"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

-- ── 2. EXCLUDE — ACTIVE 적용기간 중첩 차단 ──────────────────────────
-- `daterange(from, to, '[)')` — to 는 미포함, NULL 이면 unbounded upper bound.
-- 이 하나로 부분중첩 · 완전포함 · open-ended 중첩 · 동일 시작일이 전부 막히고,
-- 경계가 맞닿는 기간(`~2027-01-01` 과 `2027-01-01~`)은 허용된다.
--
-- ★ `WHERE (status = 'ACTIVE')` — 그 밖의 status 는 기간이 겹쳐도 된다.
ALTER TABLE "bom_header"
  ADD CONSTRAINT "bom_header_active_period_excl"
  EXCLUDE USING gist (
    "parent_sku_id" WITH =,
    daterange("effective_from", "effective_to", '[)') WITH &&
  ) WHERE ("status" = 'ACTIVE');

-- ── 3. 표현식 UNIQUE — 동일 구성품 중복 라인 차단 ───────────────────
-- 하나의 BOM 안에서 (구성품 SKU, 대체그룹) 조합은 1개뿐이다.
-- `COALESCE(..., '')` 로 **NULL 끼리도 같은 그룹**으로 접는다.
-- ⚠️ 같은 componentSku 라도 `alternate_group` 이 다르면 복수 라인은 허용된다.
CREATE UNIQUE INDEX "ux_bom_line_component_group"
  ON "bom_line" ("bom_header_id", "component_sku_id", COALESCE("alternate_group", ''));
