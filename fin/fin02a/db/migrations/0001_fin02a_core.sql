-- FIN-02A: 원천 데이터 추적 및 수집 실행 기반
-- 계획서 §5 의 legal_entities / source_accounts / external_mappings / source_runs / raw_objects / source_records 에 해당한다.
-- 접두사 fin_ 는 별도 DB 사용이 기본이라는 전제에서 SCM/WMS 테이블과의 이름 충돌을 추가로 막기 위한 것이다.
-- 금액·손익 컬럼은 이 범위에 없다.

CREATE TABLE fin_legal_entities (
  id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  name        text NOT NULL
);

CREATE TABLE fin_source_systems (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  kind        text NOT NULL CHECK (kind IN ('BANK', 'SALES', 'DELIVERY', 'ADS', 'ACCOUNTING', 'FX')),
  name        text NOT NULL
);

-- 원천 계정: 외부 계정 ID 는 (법인, 원천 시스템) 범위 안에서만 유일하다. 다른 법인의 같은 외부 ID 는 충돌하지 않는다.
CREATE TABLE fin_source_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id     smallint NOT NULL REFERENCES fin_legal_entities (id),
  source_system       text NOT NULL REFERENCES fin_source_systems (code),
  external_account_id text NOT NULL,
  alias               text NOT NULL UNIQUE,
  currency            char(3),
  active_from         date NOT NULL,
  active_to           date,
  CONSTRAINT fin_source_accounts_scope_uq UNIQUE (legal_entity_id, source_system, external_account_id),
  CONSTRAINT fin_source_accounts_active_ck CHECK (active_to IS NULL OR active_to >= active_from)
);

-- 외부 코드 → 내부 ID. 원천 시스템(+계정) 범위, 유효기간.
CREATE TABLE fin_external_mappings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system     text NOT NULL REFERENCES fin_source_systems (code),
  source_account_id uuid REFERENCES fin_source_accounts (id),
  entity_type       text NOT NULL CHECK (entity_type IN ('LEGAL_ENTITY', 'BANK_ACCOUNT', 'COUNTERPARTY', 'PRODUCT', 'BRAND', 'CHANNEL', 'AD_ACCOUNT')),
  external_code     text NOT NULL,
  internal_id       text NOT NULL,
  valid_from        date NOT NULL,
  valid_to          date,
  CONSTRAINT fin_external_mappings_valid_ck CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX fin_external_mappings_scope_uq
  ON fin_external_mappings (source_system, COALESCE(source_account_id, '00000000-0000-0000-0000-000000000000'::uuid), entity_type, external_code, valid_from);

-- 수집 실행 이력. 네트워크 성공 ≠ 수집 완료: status 는 파이프라인 단계 결과로만 결정된다.
CREATE TABLE fin_source_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id uuid NOT NULL REFERENCES fin_source_accounts (id),
  period_from       date NOT NULL,
  period_to         date NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  status            text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED')),
  stages            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 단계별 결과(OK / NOT_IMPLEMENTED / FAILED / SKIPPED)
  error_code        text,
  error_message     text,                                  -- 비식별·비밀값 제거 후 저장
  source_as_of      timestamptz,                           -- 원천 데이터 기준 시각. 미제공이면 NULL
  received_count    integer CHECK (received_count >= 0),   -- 확인하지 못하면 NULL. 실제 0건은 0
  note              text,
  CONSTRAINT fin_source_runs_period_ck CHECK (period_to >= period_from),
  CONSTRAINT fin_source_runs_finish_ck CHECK ((status = 'RUNNING') = (finished_at IS NULL))
);
CREATE INDEX fin_source_runs_account_idx ON fin_source_runs (source_account_id, started_at DESC);

-- 원본 객체: 바이트를 변경하지 않고 보관(저장소 키), 해시·실행 ID·수집 시각·콘텐츠 유형.
-- 같은 해시가 다시 수신돼도 실행마다 행을 남긴다(실행 이력 삭제 금지).
CREATE TABLE fin_raw_objects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_run_id   uuid NOT NULL REFERENCES fin_source_runs (id),
  sha256          char(64) NOT NULL,
  byte_size       bigint NOT NULL CHECK (byte_size >= 0),
  content_type    text NOT NULL,
  storage_key     text NOT NULL UNIQUE,
  collected_at    timestamptz NOT NULL DEFAULT now(),
  request_summary jsonb NOT NULL DEFAULT '{}'::jsonb     -- 메서드·비밀값 제거 URL·헤더 이름만. 헤더 값·토큰 저장 금지
);
CREATE INDEX fin_raw_objects_run_idx ON fin_raw_objects (source_run_id);
CREATE INDEX fin_raw_objects_sha_idx ON fin_raw_objects (sha256);

-- 원천 레코드(업무 관측 단위). source_key 가 NULL 이면 미식별: 자동 중복 제거하지 않고 매번 보존.
CREATE TABLE fin_source_records (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id    uuid NOT NULL REFERENCES fin_source_accounts (id),
  source_key           text,
  current_version      integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  current_payload_hash char(64) NOT NULL,
  first_run_id         uuid NOT NULL REFERENCES fin_source_runs (id),
  last_run_id          uuid NOT NULL REFERENCES fin_source_runs (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fin_source_records_key_uq ON fin_source_records (source_account_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX fin_source_records_unidentified_idx ON fin_source_records (source_account_id) WHERE source_key IS NULL;

-- 관측 버전: 동일 키·변경 내용은 새 버전. 이전 payload 도 보존. 원본 객체·실행으로 추적.
CREATE TABLE fin_source_record_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id  uuid NOT NULL REFERENCES fin_source_records (id),
  version           integer NOT NULL CHECK (version >= 1),
  payload_hash      char(64) NOT NULL,
  payload           jsonb NOT NULL,
  raw_object_id     uuid NOT NULL REFERENCES fin_raw_objects (id),
  source_run_id     uuid NOT NULL REFERENCES fin_source_runs (id),
  observed_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_source_record_versions_uq UNIQUE (source_record_id, version)
);
CREATE INDEX fin_source_record_versions_raw_idx ON fin_source_record_versions (raw_object_id);
