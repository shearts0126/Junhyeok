-- 바코드 중복 예외 승인 대기 후보 (T04-4A)
--
-- 근거: docs/11_설계복구_Barcode중복예외승인.md §8
--       (2026-08-10 Barcode Duplicate Approval Design Recovery Decision)
--
-- 중복 예외 요청은 `status = 'PENDING_DUPLICATE'` 인 SkuBarcode 행(candidate)으로
-- 표현된다. 같은 SKU 에 같은 바코드로 승인 대기 후보가 **여러 개 생기면 안 된다.**
--
-- ⚠️ 조건부(partial) UNIQUE 는 Prisma 스키마 언어로 표현할 수 없어 raw SQL 로 추가한다.
--    T04-1 의 `ux_barcode_active` · `ux_barcode_primary` 와 같은 방식이며,
--    이 index 는 그 둘과 **서로 다른 규칙**이다 (합치지 않는다).
--
-- ⛔ `sku_barcode` 테이블 구조는 바꾸지 않는다 — `status` 는 이미 VARCHAR(20) 이고
--    열거값 CHECK 가 없으므로 'PENDING_DUPLICATE'(18자) 저장에 컬럼 변경이 필요 없다.
--    (T04-1 에서 status allowlist CHECK 를 두지 않기로 한 결정이 유지된다.)
--
-- ⛔ 기존 migration 을 수정하지 않는다.

CREATE UNIQUE INDEX "ux_barcode_pending_duplicate"
  ON "sku_barcode"("sku_id", "barcode")
  WHERE "status" = 'PENDING_DUPLICATE';
