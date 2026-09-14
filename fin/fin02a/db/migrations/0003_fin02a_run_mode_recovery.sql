-- FIN-02A 최종 보완: 실행 모드(정기/검증)와 수동 복구 마감의 주체·사유 기록.
ALTER TABLE fin_source_runs
  ADD COLUMN mode text NOT NULL DEFAULT 'SCHEDULED' CHECK (mode IN ('SCHEDULED', 'VERIFICATION')),
  ADD COLUMN closed_by text,        -- 수동 복구 마감 시 실행 주체(담당자 식별자). 자동 마감 없음
  ADD COLUMN close_reason text;     -- 수동 복구 마감 사유(비밀값 제거·길이 제한)
