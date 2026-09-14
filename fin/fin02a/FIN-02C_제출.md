# FIN-02C 제출: 큐·worker·실행 소유권 기반

> 4차 검토 보완(수동 복구 경합·큐 등록 경계·readiness 집합 검사·환율 수집기 명세 게이트)은 `FIN-02ABC_보완결과.md` 에 있다. 이 문서의 상태 전이·잠금 규칙은 그 보완을 반영해 읽어야 한다(작업 상태에 `queued_at`, 복구 마감 시 NEEDS_REVIEW/MANUAL_CLOSE 추가).

- 상태: **READY_FOR_REVIEW** (FIN-02C 에 한함). FIN-02A/B 최종 승인과 별개. 실제 외부 수집 스케줄은 활성화하지 않았다.
- 검증: 시험용 일회용 PostgreSQL + 전용 Redis(로컬 `redis-server` 7.0, 포트 6380, CI 는 `redis:7-alpine` 서비스) + 시험용 수집기. **외부 연동 성공을 뜻하지 않는다.**
- 설계 결정(설계 담당자 확정) 준수: 정기 실행은 스케줄러→큐→worker, 수동 실행은 같은 큐에 넣는 CLI, HTTP 수집 실행 API 없음, SCHEDULED/VERIFICATION 유지. 복구는 heartbeat·잠금 우선, 자동 실패 마감·잠금 탈취 없음.

## 1. 추가한 의존성과 CI

| 항목 | 내용 |
|---|---|
| 런타임 의존성 | `bullmq@6.3.6`, `ioredis@6.0.0` (fin/fin02a 자체 `package.json`·`pnpm-lock.yaml`) |
| 개발 도구 | 없음 추가. Redis 는 시스템 `redis-server`(`scripts/dev-redis.sh`, 6380, 무영속) |
| CI (`.github/workflows/ci.yml` `fin02a` 잡) | `redis:7-alpine` 서비스 컨테이너(6380) 추가, `FIN02A_REDIS_URL` 환경변수. 루트 `verify` 잡·SCM/WMS 검사 변경 없음 |
| 환경변수 | `FIN02A_REDIS_URL` (필수: worker·enqueue·큐 시험) |

## 2. 변경 파일

| 경로 | 내용 |
|---|---|
| `db/migrations/0004_fin02c_jobs_leases.sql` | `fin_collection_jobs`(요청 ID UNIQUE, 상태, 시도 수, current_run_id 펜스), `fin_job_attempts`(시도별 실행 ID·worker·세대), `fin_run_leases`(계정당 잠금·세대·heartbeat·해제), `fin_source_runs` 에 worker_id·lease_generation·job_id, `fin_collection_schedules`(구조만, enabled 기본 false) |
| `src/queue/lease.ts` | 잠금 획득(해제된 잠금만, 세대+1)·heartbeat·펜스(`assertLeaseHeld`)·해제·이상 후보 조회·수동 해제 |
| `src/queue/jobs.ts` | 작업 멱등 생성(요청 ID), 시도 시작/종료, 실행 연결, **펜스된 상태 갱신**(current_run_id 일치 시만), 재투입, 스케줄 조회 |
| `src/queue/queue.ts` | BullMQ 큐·Redis 연결, `enqueueCollection`(DB 멱등 생성 후에만 큐 추가, jobId=요청 ID), 지연 재투입 |
| `src/queue/retry.ts` | 재시도 정책(§4) |
| `src/queue/registry.ts` | 수집기 레지스트리(키→인스턴스). 미등록 키는 외부 요청 없이 거부 |
| `src/queue/worker.ts` | 처리기 `processCollectionJob`(시험에서 직접 호출 가능)와 BullMQ `Worker` 생성 |
| `src/collector/pipeline.ts` | `lease`·`jobId`·`onRunStarted` 입력, 관측 커밋 트랜잭션 안 소유권 펜스, `OWNERSHIP_LOST`, `retryAfterMs` 전달 |
| `src/runs/repo.ts` | `startRun` 에 worker_id·lease_generation·job_id |
| `src/recovery.ts` | 미리보기에 heartbeat 이상 후보 포함, 수동 마감 시 소유자 생존 확인(OWNER_ALIVE 거부) |
| `scripts/enqueue.ts`, `scripts/worker.ts`, `scripts/recovery.ts`(release-lease), `scripts/dev-redis.sh` | CLI·프로세스 |
| `test/queue.test.ts`(10건), `test/recovery-lease.test.ts`(1건) | 검증 |

## 3. 작업 상태 전이

```
enqueue(요청 ID) ──DB UNIQUE──▶ QUEUED ──worker 잠금 획득 실패──▶ QUEUED (지연 재투입, 시도 수 미포함)
QUEUED / RETRY_SCHEDULED ──잠금 획득·시도 시작──▶ RUNNING ──runCollection──▶
   SUCCEEDED (실행 SUCCEEDED)
   PARTIAL   (실행 PARTIAL: 미구현 단계·정기 실행 게이트 거부)
   BLOCKED   (실행 BLOCKED: 자격 부족)
   RETRY_SCHEDULED (실행 FAILED/TRANSIENT, 시도 < 3) ──지연 후 새 시도(새 실행 ID)──▶ RUNNING …
   FAILED    (FAILED/PERMANENT, 또는 TRANSIENT 3회 소진, 또는 수집기 미등록)
   NEEDS_REVIEW (FAILED/STORAGE·UNKNOWN, OWNERSHIP_LOST, 종료 기록 실패 UNRECORDED)
```
상태 갱신은 `current_run_id = 이 시도의 실행 ID` 조건으로만 반영된다(펜스). 시도마다 `fin_job_attempts` 행과 새 `fin_source_runs` 행이 연결된다.

## 4. 중복 작업·실행 잠금·재시도 규칙(구현)

- 작업에는 원천 계정·대상 기간·모드·요청 ID 가 있다. 같은 요청 ID 재전송은 DB UNIQUE 로 거부되고 BullMQ jobId 도 요청 ID 라 큐에서도 중복되지 않는다. 의도한 재수집은 새 요청 ID.
- 같은 계정은 잠금(`fin_run_leases`, 계정 PK)으로 한 번에 하나만 실행. 다른 계정은 독립.
- 업무 데이터 중복 방지는 기존 관측·버전 처리 그대로(큐 중복과 별개).
- 소유권 = (worker_id, generation). 잠금 획득 시 세대가 1 증가하며, 관측 커밋 트랜잭션은 `SELECT … FOR UPDATE` 로 같은 (계정, worker, 세대, 미해제)를 확인한다. 실패하면 커밋하지 않고 자기 실행만 `OWNERSHIP_LOST` 로 종료한다. 작업 상태 갱신도 실행 ID 펜스라 새 실행의 결과를 덮어쓰지 못한다.
- 큐 전달 보장만으로 "정확히 한 번" 을 주장하지 않는다. 중복 전달은 (a) 시작 가능 상태 확인, (b) 계정 잠금, (c) 커밋 펜스, (d) 상태 펜스 네 겹으로 막는다.
- heartbeat 30초(개발 기본), 2분 미갱신은 소유권 이상 **후보**, 60분 이상 RUNNING 은 장기 실행 **후보**. 둘 다 자동 마감·탈취 근거가 아니다. 수동 마감은 소유자 heartbeat 가 최근이면 `OWNER_ALIVE` 로 거부한다.
- 재시도: TRANSIENT 만, 최초 포함 최대 3회, 대기 1분·5분, `retryAfterMs`(공급자 공식 대기) 우선. CREDENTIALS·NOT_IMPLEMENTED·PERMANENT 재시도 없음. STORAGE·UNKNOWN 은 NEEDS_REVIEW.

## 5. 소유권 상실 처리

이전 worker 가 멈췄다가 복귀한 경우: 담당자가 잠금을 수동 해제(`recovery release-lease --confirm`)하고 새 worker 가 세대 n+1 로 처리한 뒤, 이전 worker 가 대조까지 마치고 커밋을 시도하면 펜스에서 `LeaseLostError` → 롤백, 자기 실행 `FAILED/OWNERSHIP_LOST`(PERMANENT, 재시도 없음), 관측·새 작업 상태는 새 소유자 것만 남는다(검증 6). 잠금이 해제되지 않았다면 새 작업은 `LOCK_HELD` 로 대기하며(검증 5), 이 상태는 미리보기 `leaseAnomalies` 로 드러난다.

## 6. 검증 결과 (`evidence/test.log`)

| # | 기준 | 결과 |
|---|---|---|
| 1 | 같은 요청 ID 2회 | 두 번째 enqueue 거부(DUPLICATE_REQUEST_ID), 완료 후 중복 전달은 JOB_NOT_STARTABLE, 작업·실행·시도 각 1 |
| 2 | 새 요청 ID 재수집 | 허용, 실행 2, 관측 레코드 2(업무 중복 없음), 실행별 연결 4 |
| 3 | 같은 계정 2작업 | 두 번째 외부 요청이 첫 실행 종료 후 시작, 잠금 세대 2 |
| 4 | 다른 계정 | 두 요청이 겹쳐 시작, 둘 다 SUCCEEDED |
| 5 | worker 중단 | heartbeat 이상 후보로 식별, 실행 RUNNING·잠금 미해제 유지, 새 작업은 LOCK_HELD 대기 |
| 6 | 오래된 worker | 커밋 거부(OWNERSHIP_LOST), 새 소유자의 관측·작업 상태만 존재 |
| 7 | 임시 장애 | 2회 실패 후 3번째 성공, 시도 3·실행 ID 3, 4회 실패는 3회에서 FAILED. Retry-After 우선·PERMANENT 미재시도·STORAGE/UNKNOWN NEEDS_REVIEW |
| 8 | 자격 부족·미구현 | 시도 1회, 외부 요청 0, 지연 큐 0 |
| 9 | 로그 장애 | 작업 SUCCEEDED 유지, logFailed 신호만 |
| 10 | 미구현 수집기 | 정기 실행에서 요청 단계 SKIPPED, 외부 요청 0. 미등록 키도 거부. 활성 스케줄 0 |
| + | 복구·소유권 | heartbeat 최근이면 수동 마감 거부(OWNER_ALIVE), 잠금 해제는 세대 일치·--confirm 에서만 |

전체: 7 파일 47 테스트 통과(FIN-02A/B 32 + FIN-02C 11 + 환율 4).

## 7. 남은 제약

- 스케줄러 프로세스(cron 평가·enqueue 루프)는 미구현. `fin_collection_schedules` 구조만 있고 활성 행이 없다.
- 자동 마감·잠금 탈취 없음(설계 결정). 죽은 worker 의 잠금은 담당자가 `release-lease --confirm` 로 해제해야 다음 작업이 진행된다.
- 잠금 대기(LOCK_HELD) 재투입은 지연 재시도 방식이며 대기 시간 상한·알림은 없다.
- 등록된 실제 수집기는 `koreaexim-fx` 1개이며 실수집은 인증키·허용 네트워크가 있을 때만 검증 가능하다.
