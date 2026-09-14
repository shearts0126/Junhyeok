-- FIN-02C 보완: 큐 등록 경계와 수동 복구 확인 근거.
-- queued_at: DB 작업 생성 후 큐(Redis) 등록이 실제로 성공한 시각. NULL 이면 "DB 에만 있는 작업"(큐 등록 실패·응답 유실) 후보이며
--            enqueue --resync 가 같은 jobId 로 다시 등록한다(BullMQ 는 같은 jobId 를 중복 추가하지 않는다).
--            지연 재투입(재시도·잠금 대기)도 같은 규칙: 상태를 바꿀 때 NULL 로 두고 등록 성공 후 채운다.
ALTER TABLE fin_collection_jobs ADD COLUMN queued_at timestamptz;

-- 수동 복구 적용 근거: 담당자가 명시적으로 입력한 확인 종류(OWNER_TERMINATED | NO_ACTIVE_WORK). heartbeat 노후만으로는 마감하지 않는다.
ALTER TABLE fin_source_runs ADD COLUMN close_verification text
  CHECK (close_verification IS NULL OR close_verification IN ('OWNER_TERMINATED', 'NO_ACTIVE_WORK'));
