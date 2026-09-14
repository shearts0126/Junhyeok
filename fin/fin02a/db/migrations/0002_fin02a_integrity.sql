-- FIN-02A 보완: 매핑 기간 중복 차단, 시스템·계정·실행·원본 정합 제약, 실행별 관측 연결, 실패 분류.
-- 운영 이력 없음(시험용 DB 에서만 적용). 0001 위에 ALTER 로 누적한다.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 6. 매핑: 동일 (원천 시스템, 계정 범위, 대상 종류, 외부 코드) 안에서 유효기간이 겹치면 거부.
--    계정 범위와 시스템 기본 범위(NULL)는 서로 다른 범위이므로 공존을 허용한다(조회 우선순위는 계정 범위).
DROP INDEX IF EXISTS fin_external_mappings_scope_uq;
ALTER TABLE fin_external_mappings
  ADD CONSTRAINT fin_external_mappings_no_overlap EXCLUDE USING gist (
    source_system WITH =,
    COALESCE(source_account_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    entity_type WITH =,
    external_code WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  );

-- 6. 매핑의 source_system 은 연결한 계정의 시스템과 일치해야 한다(복합 FK).
ALTER TABLE fin_source_accounts ADD CONSTRAINT fin_source_accounts_id_system_uq UNIQUE (id, source_system);
ALTER TABLE fin_external_mappings
  ADD CONSTRAINT fin_external_mappings_account_system_fk
  FOREIGN KEY (source_account_id, source_system) REFERENCES fin_source_accounts (id, source_system);

-- 7. 실패 분류: 재시도 로직이 영구 미구현·자격 부족을 반복 실행하지 않도록 원인을 구분한다.
ALTER TABLE fin_source_runs
  ADD COLUMN failure_kind text CHECK (failure_kind IN ('NOT_IMPLEMENTED', 'CREDENTIALS', 'TRANSIENT', 'PERMANENT', 'STORAGE', 'UNKNOWN')),
  ADD COLUMN error_class text,
  ADD CONSTRAINT fin_source_runs_failure_kind_ck CHECK ((status = 'SUCCEEDED') = (failure_kind IS NULL) OR status = 'RUNNING');

-- 6. 원천 레코드·원본·버전이 서로 다른 계정·실행을 조합하지 못하게 복합 FK 를 건다.
ALTER TABLE fin_source_runs ADD CONSTRAINT fin_source_runs_id_account_uq UNIQUE (id, source_account_id);
ALTER TABLE fin_source_records
  ADD CONSTRAINT fin_source_records_id_account_uq UNIQUE (id, source_account_id),
  ADD CONSTRAINT fin_source_records_first_run_account_fk FOREIGN KEY (first_run_id, source_account_id) REFERENCES fin_source_runs (id, source_account_id),
  ADD CONSTRAINT fin_source_records_last_run_account_fk FOREIGN KEY (last_run_id, source_account_id) REFERENCES fin_source_runs (id, source_account_id);
ALTER TABLE fin_raw_objects ADD CONSTRAINT fin_raw_objects_id_run_uq UNIQUE (id, source_run_id);

ALTER TABLE fin_source_record_versions ADD COLUMN source_account_id uuid;
UPDATE fin_source_record_versions v SET source_account_id = r.source_account_id FROM fin_source_records r WHERE r.id = v.source_record_id;
ALTER TABLE fin_source_record_versions
  ALTER COLUMN source_account_id SET NOT NULL,
  ADD CONSTRAINT fin_source_record_versions_id_record_uq UNIQUE (id, source_record_id),
  ADD CONSTRAINT fin_srv_record_account_fk FOREIGN KEY (source_record_id, source_account_id) REFERENCES fin_source_records (id, source_account_id),
  ADD CONSTRAINT fin_srv_run_account_fk FOREIGN KEY (source_run_id, source_account_id) REFERENCES fin_source_runs (id, source_account_id),
  ADD CONSTRAINT fin_srv_raw_run_fk FOREIGN KEY (raw_object_id, source_run_id) REFERENCES fin_raw_objects (id, source_run_id);

-- 5. 실행별 관측 연결: 내용이 같아 업무 버전이 늘지 않아도 (실행, 레코드, 관측한 버전, 원본) 연결을 매 실행 남긴다.
CREATE TABLE fin_source_record_observations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_run_id     uuid NOT NULL,
  source_account_id uuid NOT NULL,
  source_record_id  uuid NOT NULL,
  version_id        uuid NOT NULL,
  raw_object_id     uuid NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('INSERTED', 'UNCHANGED', 'VERSIONED', 'UNIDENTIFIED')),
  observed_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_sro_run_record_uq UNIQUE (source_run_id, source_record_id),
  CONSTRAINT fin_sro_run_account_fk FOREIGN KEY (source_run_id, source_account_id) REFERENCES fin_source_runs (id, source_account_id),
  CONSTRAINT fin_sro_record_account_fk FOREIGN KEY (source_record_id, source_account_id) REFERENCES fin_source_records (id, source_account_id),
  CONSTRAINT fin_sro_version_record_fk FOREIGN KEY (version_id, source_record_id) REFERENCES fin_source_record_versions (id, source_record_id),
  CONSTRAINT fin_sro_raw_run_fk FOREIGN KEY (raw_object_id, source_run_id) REFERENCES fin_raw_objects (id, source_run_id)
);
CREATE INDEX fin_sro_record_idx ON fin_source_record_observations (source_record_id, observed_at);
CREATE INDEX fin_sro_run_idx ON fin_source_record_observations (source_run_id);
