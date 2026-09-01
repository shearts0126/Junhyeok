-- REVERSAL 재취소 차단 (T2-3).
--
-- 근거: docs/00_요구사항_이해와_충돌검토_v0.2.md C-14
--       docs/03_ERD와_Prisma스키마_v0.2.md §"REVERSAL 재취소 차단 트리거 (C-14)"
--       docs/04_재고_PostingService와_현재고전략_v0.2.md §8.9
--       docs/07_개발백로그와_테스트전략_v0.2.md T2-3 · TC-POST-203
--
-- ## 무엇을 막는가
--
--   A            정상 거래
--   REV(A)       A 를 취소 — 허용
--   REV(REV(A))  취소를 다시 취소 — ⛔ 차단
--
-- 취소의 취소를 허용하면 `A → REV(A) → REV(REV(A)) → …` 체인이 생겨
-- ① 어느 것이 유효 거래인지 추론할 수 없고 ② 감사 추적이 무의미해진다.
-- 되돌림이 필요하면 **원인문서를 근거로 신규 정상거래**를 만든다 (C-14).
--
-- ## 이것은 5중 방어의 마지막 층이다
--
--   1. 도메인 `reverse()` 진입부      (T2-13)
--   2. Posting 검증 ⑫                 (T2-5~)
--   3. API route → 422                (T2-13)
--   4. 화면 — 취소 버튼 미노출        (T2-21)
--   5. **DB 트리거 ← 이 migration**   (T2-3)
--
-- 앞의 네 층은 코드 경로이고, 이 트리거만이 psql·관리도구·잘못된 배치의
-- **직접 INSERT** 까지 막는다 (TC-POST-203 이 요구하는 것이 정확히 그것이다).
--
-- ⚠️ 이 DDL 은 `prisma migrate diff` 가 보지 못한다 — drift gate 를 통과해도
--    빠져 있을 수 있으므로 `tests/db/inventory-schema.test.ts` 의 카탈로그
--    테스트가 유일한 방어선이다 (T0-7 · T2-2 트리거와 같은 사정).

-- ★ 판정 기준은 **대상 거래의 transaction_type 하나뿐**이다.
--
-- ⛔ `status` 를 보지 않는다. 대상 REVERSAL 이 POSTED 든 REVERSED 든 똑같이
--    막는다 — "취소는 취소 대상이 아니다" 는 유형의 성질이지 상태의 성질이
--    아니기 때문이다.
--
-- ⚠️ 기존 조건부 UNIQUE `ux_txn_reversal` 과 **역할이 다르다**:
--      ux_txn_reversal : 같은 원거래를 가리키는 POSTED 반대거래의 중복 차단
--      이 트리거       : REVERSAL 자체를 취소 대상으로 삼는 것을 차단
--    두 제약은 서로를 대체하지 못한다 — 재취소 체인의 각 `reversal_of_id` 는
--    전부 다른 값이라 UNIQUE 에는 아예 걸리지 않는다.
--
-- ⛔ self-reversal · cycle(A→B→A) · "non-REVERSAL 은 reversal_of_id 를 가질 수
--    없다" 규칙을 여기서 만들지 않는다 — 정본 문서에 그런 규칙이 없다.
CREATE OR REPLACE FUNCTION reject_reversal_of_reversal()
RETURNS trigger AS $$
BEGIN
  IF NEW.reversal_of_id IS NOT NULL THEN
    IF (
      SELECT transaction_type
      FROM inventory_transaction
      WHERE id = NEW.reversal_of_id
    ) = 'REVERSAL' THEN
      RAISE EXCEPTION 'REVERSAL_OF_REVERSAL_NOT_ALLOWED'
        USING HINT =
          '취소를 되돌리려면 원인문서를 근거로 신규 정상거래를 생성하세요.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reject_reversal_of_reversal() IS
  'REVERSAL 거래를 취소 대상으로 삼는 INSERT 를 차단한다 (T2-3, C-14).';

-- ⛔ `BEFORE INSERT` 만이다. UPDATE·DELETE·TRUNCATE 를 추가하지 않는다 —
--    정본(docs/03 · docs/04)이 INSERT 만 명시한다.
-- ⛔ `WHEN` 절을 쓰지 않는다 — 조건은 함수 안의 IF 가 판정한다.
CREATE TRIGGER trg_no_reversal_of_reversal
BEFORE INSERT
ON inventory_transaction
FOR EACH ROW
EXECUTE FUNCTION reject_reversal_of_reversal();
