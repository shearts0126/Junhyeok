-- 감사로그 불변성 (T0-7).
--
-- 애플리케이션 코드만으로 불변성을 보장하지 않는다. psql·관리도구·잘못된 배치에서
-- 직접 실행하는 SQL 도 DB 에서 막아야 감사 기록이 근거가 된다.
--
--   UPDATE   → row-level trigger
--   DELETE   → row-level trigger
--   TRUNCATE → statement-level trigger (행이 없어 row-level 로는 잡을 수 없다)
--
-- ⚠️ PostgreSQL 한계: 테이블 소유자와 superuser 는
--      ALTER TABLE audit_log DISABLE TRIGGER ALL
--    로 트리거를 끌 수 있다. DB 수준에서 이를 막을 방법은 없다.
--    운영에서는 애플리케이션 롤에 테이블 소유권을 주지 않고, 소유자 계정 사용을
--    별도 통제·감사 대상으로 둔다. README 에 명시한다.

CREATE OR REPLACE FUNCTION audit_log_prevent_modification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_LOG_IMMUTABLE'
    USING HINT = '감사로그는 불변입니다. 정정은 새 로그를 추가해 표현하세요.';
END;
$$;

COMMENT ON FUNCTION audit_log_prevent_modification() IS
  '감사로그 불변성 보장. UPDATE/DELETE/TRUNCATE 를 차단한다 (T0-7).';

-- UPDATE 차단
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_prevent_modification();

-- DELETE 차단 (단건·대량 모두 행마다 발동한다)
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_prevent_modification();

-- TRUNCATE 차단 (행 단위가 아니므로 statement-level)
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_log_prevent_modification();
