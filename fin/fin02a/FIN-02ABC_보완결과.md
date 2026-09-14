# FIN-02A/B/C 4차 검토 보완 결과 (READY_FOR_REVIEW)

- 기준 HEAD: `de10ed0`(문서만) ← FIN-02C 구현 `608f0ac`. 이 문서는 그 이후 보완 커밋의 내용이다.
- 범위: 수동 복구·실행 소유권 경합, 큐 전달·DB 작업 기록 실패 경계, readiness 마이그레이션 집합 검사, 환율 수집기 명세 게이트. 신규 기능(FIN-02D·화면·추가 공급자) 없음. 기존 SCM/WMS 코드·DB·배포 변경 없음. 루트 변경 없음.
- 검증 환경: 시험용 일회용 PostgreSQL 16 + 전용 Redis 7(로컬). 외부 연동 성공을 뜻하지 않는다.

## 1. 확인 항목별 충족/보완/미확인

| # | 항목 | 판정 | 근거(코드·시험) |
|---|---|---|---|
| 3-1 | heartbeat 2분·RUNNING 60분은 확인 후보일 뿐 | 충족(기존) | `listStaleRunCandidates`, `listLeaseAnomalies` 는 조회만. 시험 D |
| 3-2 | 수동 마감에 명시적 확인 입력·사유 필요 | **보완** | `ManualCloseInput.verified: OWNER_TERMINATED\|NO_ACTIVE_WORK` 없으면 `CONFIRMATION_REQUIRED`. CLI `--verified` 필수(없으면 종료 코드 2, 변경 없음). `fin_source_runs.close_verification` 에 기록(0005). 시험 D, app CLI |
| 3-3 | preview 에 실행 ID·시작 시각·소유자·세대값 | **보완** | `StaleRunCandidate.owner{workerId, leaseGeneration, jobId}`, `.lease{generation, workerId, runId, heartbeatAt, releasedAt, heartbeatStaleSeconds}`, `closeArgs{run, startedAt, generation}`. 시험 A, 4 |
| 3-4 | 적용 시 실행·lease 를 트랜잭션 안에서 잠그고 상태·세대값 재확인 | **보완** | `closeStaleRunManually` 가 `withTx` 안에서 `lockLease`(잠금 행 FOR UPDATE) → 실행 행 FOR UPDATE → RUNNING·started_at·generation·runId·heartbeat 재확인 → 조건부 UPDATE. 시험 A/B/C/E |
| 3-5 | worker 커밋·소유권 변경·복구가 같은 잠금 순서 | 충족(기존 순서 유지, 복구를 맞춤) | worker: `assertLeaseHeld`(잠금 행) → `observe` → `finishRun`(실행 행). 복구: 잠금 행 → 실행 행. `acquireLease`·`releaseLease` 는 잠금 행만. 시험 E(실제 행 잠금 경합) |
| 3-6 | 소유권 변경·정상 완료가 먼저면 복구 거부 | **보완** | `OWNERSHIP_CHANGED`(세대값 불일치 또는 잠금이 다른 실행을 가리킴), `NOT_RUNNING`. 시험 A, B, E |
| 3-7 | 복구가 먼저 확정되면 이전 worker 는 관측·종료·heartbeat 로 되살릴 수 없음 | **보완** | 복구가 같은 세대 잠금을 해제 → `assertLeaseHeld` LeaseLostError(관측 롤백), `finishRun` 0행(status≠RUNNING), `heartbeat` 0행. 시험 C |
| 3-8 | heartbeat 노후만으로 자동 마감·잠금 탈취 없음 | 충족 + **보완** | 자동 경로 없음. `releaseLeaseManually` 도 `verified` 필수·세대값 일치·`OWNER_ALIVE` 검사로 잠금 행을 잠근 채 적용. 시험 D, 6 |
| 4-1 | DB 작업 생성 후 Redis 등록 실패 | **보완** | `QUEUE_REGISTRATION_FAILED` 반환(작업은 QUEUED/`queued_at NULL`), `resyncUnqueuedJobs`·`pnpm enqueue --resync`(종료 코드 6 안내). 시험 1 |
| 4-2 | Redis 등록 성공 후 응답 유실로 같은 요청 재전송 | **보완** | `DUPLICATE_REQUEST_ID` + `queued_at` 비어 있으면 같은 jobId 로 재등록(`requeued=true`), BullMQ 는 같은 jobId 를 중복 추가하지 않음(큐 항목 1개 확인). 시험 2 |
| 4-3 | 완료된 작업의 큐 재전달 | 충족(기존) + 시험 추가 | worker 상태 검사 → `SKIPPED/JOB_NOT_STARTABLE`, 외부 요청·실행·시도 증가 없음. 시험 3 |
| 4-4 | 현재 시도 저장 후 worker 중단 | **보완** | 자동 정리 없음(RUNNING·잠금 유지, 재전달은 SKIPPED). 담당자 복구가 실행 FAILED·잠금 해제·작업 NEEDS_REVIEW·시도 MANUAL_CLOSE 를 한 트랜잭션으로. 시험 4 |
| 4-5 | 잠금 대기 DEFERRED 는 재시도 횟수 미소진 | 충족(기존) + 시험 추가 | `defer()` 는 `beginAttempt` 를 호출하지 않음. 3회 대기 후 attempt_count 0, 이후 시도 1회. 시험 5 |
| 4-6 | 같은 요청 ID 를 다른 계정·기간·모드로 재사용 → 명시적 충돌 | **보완** | `REQUEST_ID_CONFLICT`(계정·수집기·기간·모드 비교), CLI 종료 코드 5. 시험 7 |
| 4-7 | 이전 소유자 해제가 새 소유자 잠금을 해제하지 않음 | 충족(기존) + 시험 추가 | `releaseLease`·`heartbeat` 는 worker_id+generation 조건. 시험 6 |
| 5-1 | 개수만 같고 필요한 마이그레이션이 빠진 DB 를 ready 로 판정하지 않음 | **보완** | `REQUIRED_MIGRATIONS` 집합과 대조, 누락 시 `SCHEMA_OUTDATED` + `missingMigrations`. 시험: 0001~0004 + 앱이 모르는 파일 1개(개수 5=5) → 503 |
| 5-2 | 앱이 요구하는 마이그레이션 ID 집합 | **보완** | `src/db/migrations.ts`. 시험이 `db/migrations` 디렉터리와 정확히 일치함을 검사 |
| 5-3 | 이전 단계 스키마 → 503 | **보완** | 위 시험, 누락 적용 후 200 |
| 5-4 | 연결정보·예외 메시지 미노출 | 충족(기존) + 시험 확장 | 응답에 DB 이름·파일명·URL 없음 검사 |
| 6-1 | 명세 확인 수준을 수집기 메타데이터에 기록 | **보완** | `Collector.specStatus`(필수 필드), `KoreaeximFxCollector.specStatus='SNIPPET_ONLY'`, `SPEC_EVIDENCE`(확인 근거·미확인 6항목) |
| 6-2 | 공식 명세 미확인 상태에서 정기 등록·실행 차단 | **보완** | 파이프라인 게이트 `SCHEDULED_REQUIRES_CONFIRMED_SPEC`(외부 요청 0건), enqueue 게이트 `NOT_SCHEDULABLE`(DB 작업 없음, CLI 종료 코드 7), `isSchedulable()=false`. 스케줄 활성 행 없음 |
| 6-3 | 구현 존재 ↔ 공급자 적합성 구분 | **보완** | `hasAllStages()`(구현 완전성) 와 `isSchedulable()`(명세 포함) 분리 |
| 6-4 | 4개 시험은 가상 응답 기반 내부 시험으로 유지 | 충족 | 전부 `mode: 'VERIFICATION'` 로 명시, 게이트 시험 1건 추가(총 5건) |
| 6-5 | API 키 하나로 끝나지 않음을 명시 | **보완** | `FIN-01_환율_첫연동.md` §4 해제 조건 5단계 |
| 6-6 | 근거 없는 항목 명시 | **보완** | 같은 문서 §2a + `SPEC_EVIDENCE.unverified` |
| 7 | CI 표현 | 보완(문서) | `FIN-02AB_CI결과.md` 는 "기존 간헐 실패로 추정, 인과관계 미확정" 으로 정정 |

"충족(기존)" 은 코드를 바꾸지 않고 시험·근거만 제출한 항목이다.

## 2. 새 마이그레이션 `0005_fin02c_queue_boundary.sql`

- `fin_collection_jobs.queued_at timestamptz`: 큐 등록 성공 시각. NULL = DB 에만 있는 작업 후보.
- `fin_source_runs.close_verification text CHECK IN ('OWNER_TERMINATED','NO_ACTIVE_WORK')`: 수동 마감 확인 종류.

## 3. 상태 전이 변경점

- 작업: `RUNNING --(담당자 복구 close)--> NEEDS_REVIEW` 추가(current_run_id 가 마감한 실행일 때만). 시도 outcome `MANUAL_CLOSE` 추가.
- 잠금: `MANUAL_CLOSE:<verified>:<actor>` 사유로 해제. 자동 해제 경로는 없다.
- 큐 등록 기록: `queued_at` 은 최초 등록·지연 재투입(재시도·잠금 대기) 성공 후에만 채워지고, 상태를 RETRY_SCHEDULED 로 바꾸거나 잠금 대기로 되돌릴 때 비운다.

## 4. 추가한 시험(15건, 전부 통과)

- `test/recovery-contention.test.ts` (5): A preview 후 세대값 변경 → OWNERSHIP_CHANGED / B worker 정상 완료 선행 → NOT_RUNNING / C 확인된 복구 선행 → 이전 worker 커밋·종료·heartbeat 거부 / D 확인 입력 없음 → 마감·해제 거부 / E 실제 행 잠금 경합(worker 트랜잭션이 잠금 행 보유 중 복구 시작 → 커밋 후 NOT_RUNNING).
- `test/queue-boundary.test.ts` (7): 등록 실패+resync / 응답 유실 재전송 / 완료 작업 재전달 / 시도 저장 후 중단 + 복구 + 재전달 / DEFERRED 미소진 / 이전 소유자 해제·heartbeat 무효 / 요청 ID 충돌.
- `test/app.test.ts` (+2): REQUIRED_MIGRATIONS = 디렉터리, 이전 단계 스키마 503 SCHEMA_OUTDATED → 적용 후 200.
- `test/koreaexim-fx.test.ts` (+1): SNIPPET_ONLY 정기 실행·정기 enqueue 차단, 외부 요청 0건.
- 기존 시험 47건은 새 API(`verified`, 결과 객체)에 맞춰 갱신했으며 의미는 유지했다.

## 5. 로컬 검사(`evidence/`)

`pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test`(62건) 통과. GitHub Actions 결과는 푸시 후 `FIN-02AB_CI결과.md` 에 실행 URL·SHA·잡 결과로 추가한다. Actions 는 제가 API 로 조회한 값이며 설계 담당자의 독립 확인과 구분한다.

## 6. 5차 확인: 오래된 작업 상태 조회와 큐 상태 전환 경합

- 판정: **결함 미확인.** 시작 전환(`beginAttempt`)은 `WHERE status IN ('QUEUED','RETRY_SCHEDULED')` 조건부 UPDATE 이고, 잠금 대기(`requeueJob`)도 원래 같은 조건이라 RUNNING·완료·NEEDS_REVIEW 행을 되돌리지 않았다. 결과 전환(`setJobStatusFenced`)은 `current_run_id` 펜스다.
- 최소 강화 2건(동작 의미 유지): `requeueJob` 은 `status = 'QUEUED'` 행만 갱신(RETRY_SCHEDULED 의 재시도 대기 시각을 잠금 대기가 앞당기지 않도록), `markQueued` 는 시작 가능 상태 행만 갱신(오래된 defer 가 완료 행의 `queued_at` 을 쓰지 않도록). 둘 다 상태 값을 바꾸지 않는다.
- 시험 `test/queue-stale-race.test.ts` 2건(순서는 잠금 획득 SQL 앞 게이트·요청 단계 게이트로 제어, sleep 없음):
  - A. 같은 작업 동시 전달: B 가 QUEUED 로 읽고 대기 → A 가 RUNNING 전환·요청 중 → B 재개 → DEFERRED, 작업 RUNNING·attempt_count 1 유지, 요청 1회, 실행 1건.
  - B. 오래된 defer 와 정상 완료: B 가 QUEUED 로 읽고 대기 → A 완료(SUCCEEDED) → 다른 작업이 잠금 보유 상태에서 B 재개 → DEFERRED, 상태·queued_at 불변. B2: 잠금이 비어 있으면 B 는 잠금(세대 3)을 얻지만 조건부 시작 실패 → 자기 잠금만 `not-startable` 로 해제, 외부 요청 없음.
- 관찰 사항(수정하지 않음, 범위 밖): 큐가 이미 처리된 항목을 다시 전달(stalled 복귀)하면 RETRY_SCHEDULED 작업은 `next_attempt_at` 이전에도 시작 가능 상태로 취급된다. 시도 횟수 상한은 유지되지만 대기 시간 정책이 앞당겨질 수 있다.

## 7. 6차 보완: 재시도 예정 시각 준수(조기 전달)

- 문제: 큐가 예정 시각 전에 같은 항목을 다시 전달하면(stalled 복귀 등) RETRY_SCHEDULED 작업이 `next_attempt_at` 이전에도 시작될 수 있어 1분·5분 대기와 공급자 Retry-After 를 위반할 수 있었다.
- 최종 방어(`beginAttempt`): 조건부 UPDATE 에 `AND (next_attempt_at IS NULL OR next_attempt_at <= now())` 와 `AND NOT (status = 'RETRY_SCHEDULED' AND next_attempt_at IS NULL)` 를 추가. DB 시각 기준, 같은 시각은 실행 가능. 0행이면 사유를 `NOT_STARTABLE | NOT_DUE | INVALID_SCHEDULE` 로 구분해 반환하고 DB 오류는 전파한다(예외로 숨기지 않음).
- 사전 확인(`remainingUntilDue`): 작업을 읽은 직후 DB 시각 기준 남은 ms 를 조회해 예정 전이면 잠금·외부 요청 없이 조기 전달 처리로 간다. RETRY_SCHEDULED 인데 예정 시각이 없으면 `SKIPPED/INVALID_SCHEDULE`(즉시 실행으로 해석하지 않음). QUEUED 의 잠금 대기 시각도 같은 규칙으로 존중한다.
- 조기 전달 처리(`deferNotDue` → `ensureScheduledEntry`): 시도 횟수·`fin_job_attempts`·`next_attempt_at` 을 바꾸지 않는다. 원래 예약 항목(`__a<n>`)이나 같은 예정 시각의 재예약 항목(`__t<예정시각 ms>`)이 살아 있으면 추가하지 않고, 없으면 남은 대기시간으로 `__t<예정시각 ms>` 를 추가한다(반복 조기 전달은 같은 jobId 로 하나만). 잠금을 이미 얻은 뒤 거부되면 자기 worker_id·generation 잠금만 `not-due` 로 해제한다. worker 안에서 기다리지 않는다. 기존 backoff·Retry-After 계산은 다시 적용하지 않는다(`retry.ts` 변경 없음).
- 시험 `test/retry-schedule.test.ts` 3건(시간은 DB 값 설정으로 제어): A 예정 전 재전달(사전 확인·최종 방어·예약 유실 시 재예약·반복 조기 전달·INVALID_SCHEDULE), B 예정 시각 도래(같은 시각 포함 1회 시작, 동시 전달 시 실제 시도 1회, 완료 후 재전달 거부), C Retry-After 10분 보존·반복 조기 전달로 앞당김 없음·예약 유실 없음. 기존 시험 `queue-boundary 5` 는 잠금 대기 시각이 존중되도록 갱신했다.
