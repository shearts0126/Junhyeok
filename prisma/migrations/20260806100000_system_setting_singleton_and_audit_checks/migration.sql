-- 설정 singleton·version·감사로그 entity_id 를 DB 제약으로 고정한다 (T0-7 마감 보완).
--
-- PK 만으로는 id=2 인 두 번째 설정 행을 만들 수 있다. 설정이 두 행이 되면
-- "어느 쪽이 진짜인가"를 코드가 판단해야 하고, 그 판단은 호출부마다 갈라진다.

-- ── system_setting: 단일 행 강제 ────────────────────────────────
ALTER TABLE "system_setting"
  ADD CONSTRAINT "system_setting_singleton_check" CHECK ("id" = 1);

-- version 은 1 부터 시작해 증가만 한다. 0 이나 음수는 낙관적 동시성 토큰으로
-- 쓸 수 없는 값이다.
ALTER TABLE "system_setting"
  ADD CONSTRAINT "system_setting_version_positive_check" CHECK ("version" >= 1);

-- ── audit_log: entity_id 는 비어 있을 수 없다 ───────────────────
--
-- entity_id 는 여러 엔티티의 PK 를 문자열로 정규화한 값이다.
-- 빈 문자열이나 공백만 들어오면 "무엇에 대한 기록인가"를 알 수 없고,
-- 감사로그는 불변이라 나중에 고칠 수도 없다.
ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_entity_id_not_blank_check" CHECK (length(trim("entity_id")) > 0);

-- entity_type 도 같은 이유로 비어 있으면 안 된다.
ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_entity_type_not_blank_check" CHECK (length(trim("entity_type")) > 0);
