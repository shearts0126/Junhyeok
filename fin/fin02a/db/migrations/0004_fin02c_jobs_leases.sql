-- FIN-02C: 큐 작업·시도 이력·실행 소유권(잠금+heartbeat)·정기 실행 설정(비활성) 구조.
-- 큐 중복(요청 ID)과 업무 데이터 중복(관측·버전)은 별개다. 자동 실패 마감·잠금 탈취는 이 단계에서 구현하지 않는다.

-- 수집 작업: 원천 계정·대상 기간·모드·요청 ID. 같은 요청 ID 재전송은 중복 작업을 만들지 않는다(UNIQUE).
CREATE TABLE fin_collection_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        text NOT NULL UNIQUE,
  source_account_id uuid NOT NULL REFERENCES fin_source_accounts (id),
  collector_key     text NOT NULL,
  period_from       date NOT NULL,
  period_to         date NOT NULL,
  mode              text NOT NULL CHECK (mode IN ('SCHEDULED', 'VERIFICATION')),
  status            text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED', 'NEEDS_REVIEW')),
  attempt_count     integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts      integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  current_run_id    uuid REFERENCES fin_source_runs (id),   -- 현재(마지막) 시도의 실행. 소유권 펜스에 사용
  next_attempt_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_collection_jobs_period_ck CHECK (period_to >= period_from)
);
CREATE INDEX fin_collection_jobs_account_idx ON fin_collection_jobs (source_account_id, created_at DESC);

-- 시도 이력: 재시도마다 새 수집 실행 ID 를 만들고 같은 작업의 시도로 연결한다.
CREATE TABLE fin_job_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES fin_collection_jobs (id),
  attempt_no    integer NOT NULL CHECK (attempt_no >= 1),
  run_id        uuid REFERENCES fin_source_runs (id),
  worker_id     text NOT NULL,
  generation    bigint NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  outcome       text,            -- 실행 상태(SUCCEEDED/PARTIAL/FAILED/BLOCKED) 또는 LOCK_HELD/OWNERSHIP_LOST/UNRECORDED
  failure_kind  text,
  error_code    text,
  retry_scheduled boolean NOT NULL DEFAULT false,
  CONSTRAINT fin_job_attempts_uq UNIQUE (job_id, attempt_no)
);

-- 실행 소유권(잠금): 같은 원천 계정은 한 번에 하나만. 세대값(generation)이 펜싱 토큰이다.
-- 잠금은 명시적 release 로만 해제된다(heartbeat 경과만으로 자동 탈취하지 않는다).
CREATE TABLE fin_run_leases (
  source_account_id uuid PRIMARY KEY REFERENCES fin_source_accounts (id),
  generation        bigint NOT NULL DEFAULT 0,
  worker_id         text,
  job_id            uuid REFERENCES fin_collection_jobs (id),
  run_id            uuid REFERENCES fin_source_runs (id),
  acquired_at       timestamptz,
  heartbeat_at      timestamptz,
  released_at       timestamptz,
  release_reason    text
);

-- 실행에 소유권 정보를 남긴다(펜싱 검증·추적).
ALTER TABLE fin_source_runs
  ADD COLUMN worker_id text,
  ADD COLUMN lease_generation bigint,
  ADD COLUMN job_id uuid REFERENCES fin_collection_jobs (id);

-- 정기 실행 설정(구조만). enabled 기본 false 이며 이 단계에서는 어떤 스케줄도 활성화하지 않는다.
CREATE TABLE fin_collection_schedules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id uuid NOT NULL REFERENCES fin_source_accounts (id),
  collector_key     text NOT NULL,
  cron_expression   text NOT NULL,
  timezone          text NOT NULL DEFAULT 'Asia/Seoul',
  mode              text NOT NULL DEFAULT 'SCHEDULED' CHECK (mode = 'SCHEDULED'),
  enabled           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_collection_schedules_uq UNIQUE (source_account_id, collector_key)
);
