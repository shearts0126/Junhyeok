# FIN-02A/02B/02C: 원천 데이터 추적·수집 실행 기반, NestJS 실행 기반, 큐·worker·소유권

경영대시보드(딥포인트·디스트로바) 공통 기반의 첫 조각. 계획서 §5 의 `legal_entities` / `source_accounts` / `external_mappings` / `source_runs` / `raw_objects` / `source_records` 에 해당하며, 외부 API 형식과 무관한 부분만 구현한다.

**이 범위는 FIN-02 전체가 아니다.** FIN-02C 로 BullMQ 큐·별도 worker·수동 enqueue CLI·실행 잠금/heartbeat/세대 펜스·재시도 정책·정기 실행 설정 구조(비활성)를 추가했다(`FIN-02C_제출.md`). FIN-02B 로 NestJS 실행 기반(설정 검증·DB 모듈·liveness/readiness·복구 CLI·독립 검사·CI)을 추가했다. 로그인·작업 큐·스케줄러·금융 데이터 조회 API·실제 공급자 수집기·금액/손익 계산·화면·배포는 미착수다. 앱은 루프백에만 바인딩한다. FIN-01 최종 승인과도 별개다. FIN-02B 상세는 `FIN-02B_제출.md`.

## 위치와 독립성

- 위치: `fin/fin02a/` (SCM/WMS 저장소 안, 별도 패키지). 루트 `package.json`·잠금 파일·tsconfig·eslint·CI·`src/`·`prisma/` 는 변경하지 않았다.
- 의존성: 자체 `package.json` + 자체 `pnpm-lock.yaml` + 자체 `node_modules` (`pnpm install --ignore-workspace`). 런타임 의존성은 `pg`, `@nestjs/common|core|platform-express`, `reflect-metadata`, `rxjs`. DI 는 명시적 `@Inject` 토큰만 사용한다(esbuild 가 `emitDecoratorMetadata` 를 지원하지 않음).
- DB: FIN-02A 전용 PostgreSQL 16. 루트 `docker-compose.yml`(SCM/WMS, 5432)과 분리된 `docker-compose.fin.yml`(5433) 또는 로컬 바이너리(`scripts/dev-db.sh`). SCM/WMS 의 운영 DB·Prisma 마이그레이션은 사용·실행하지 않는다. 환경변수 이름도 `FIN02A_DATABASE_URL` 로 분리했다.
- 검사 구성(FIN-02B): 루트 `tsconfig.json`·`eslint.config.ts` 는 `fin/fin02a/**` 를 제외하고(NestJS 데코레이터 옵션 충돌 회피), 대신 CI 의 `fin02a` 잡이 이 폴더의 `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` 를 별도로 실행한다. 루트 `format:check` 는 이 폴더도 계속 포함한다. `fin/FIN-01/**` 과 SCM/WMS 검사 범위는 그대로다. 대응표는 `FIN-02B_제출.md` §5.

## 실행

```bash
cd fin/fin02a
pnpm install --ignore-workspace          # 자체 node_modules

# 전용 DB (둘 중 하나)
docker compose -f docker-compose.fin.yml up -d     # 5433
#   또는 docker 가 없을 때: 로컬 PostgreSQL 16 바이너리(비루트 사용자로 initdb/pg_ctl)
scripts/dev-db.sh start                            # 출력된 FIN02A_DATABASE_URL 사용

export FIN02A_DATABASE_URL=postgresql://fin02a@127.0.0.1:5433/postgres
pnpm verify          # typecheck → lint → format:check → test(일회용 DB fin02a_test_<pid> 생성 → 마이그레이션 → 32건 → 삭제)
pnpm db:migrate      # 개발 DB 에 마이그레이션 적용
pnpm start:dev       # NestJS 앱, 127.0.0.1:3400 (루프백만). /health/live, /health/ready
scripts/dev-redis.sh start                # 전용 Redis 6380 (FIN-02C)
export FIN02A_REDIS_URL=redis://127.0.0.1:6380
pnpm enqueue --account <uuid> --collector koreaexim-fx --from 2026-09-11 --to 2026-09-11 --request-id fx-1 --mode VERIFICATION
                                          # koreaexim-fx 는 명세 미확인(SNIPPET_ONLY) → SCHEDULED 는 종료 코드 7 로 거부
pnpm enqueue --resync                     # DB 에만 남은 작업(큐 등록 실패·응답 유실)을 같은 jobId 로 재등록
pnpm worker                               # 별도 worker 프로세스(스케줄러 비활성)
pnpm recovery preview                     # 수동 복구 미리보기(상태 불변). 후보마다 소유자·세대값·heartbeat 와 closeArgs 제시
pnpm recovery close --run <id> --started-at <ISO> --generation <n> --actor <name> --reason <text> \
                    --verified OWNER_TERMINATED|NO_ACTIVE_WORK [--confirm]
pnpm recovery release-lease --account <id> --generation <n> --actor <name> --reason <text> --verified <kind> [--confirm]
```

테스트는 DB 가 없으면 실패한다(조건부 skip 없음). 모든 테스트 데이터는 시험 전용이며 실제 계좌·판매자 계정이 아니다.

## 데이터 구조 (`db/migrations/0001` ~ `0005`; 0004 큐·잠금, 0005 큐 등록 경계·복구 확인 근거)

| 테이블 | 역할 | 핵심 규칙 |
|---|---|---|
| `fin_legal_entities` | 법인 | 코드 유일 |
| `fin_source_systems` | 원천 시스템 | 종류 BANK/SALES/DELIVERY/ADS/ACCOUNTING/FX |
| `fin_source_accounts` | 원천 계정과 소속 법인 | `(법인, 원천 시스템, 외부 계정 ID)` 유일. 다른 법인의 같은 외부 ID 는 충돌하지 않음. 별칭 유일 |
| `fin_external_mappings` | 외부 코드 → 내부 ID | 원천 시스템(+계정) 범위, 유효기간. **같은 범위의 기간 중복은 EXCLUDE 제약으로 거부**(btree_gist). 계정 범위가 시스템 범위보다 우선하며 서로 다른 범위는 공존. 매핑의 시스템은 연결 계정의 시스템과 일치(복합 FK). 미매핑은 `null`(임의 생성 없음) |
| `fin_source_runs` | 수집 실행 이력 | 실행 ID, 계정, 대상 기간, 시작·종료, 상태(RUNNING/SUCCEEDED/PARTIAL/FAILED/BLOCKED), 모드(SCHEDULED/VERIFICATION), 수동 마감 주체·사유, 단계별 결과·코드(`stages`), 오류 코드·카탈로그 설명·`failure_kind`·예외 클래스명, `source_as_of`(미제공 null), `received_count`(확인 못 하면 null, 실제 0건은 0) |
| `fin_raw_objects` | 원본 보관 | 바이트 무변경 저장(`storage_key`=실행ID/sha256), sha256, 실행 ID, 수집 시각, 콘텐츠 유형, 요청 요약(원천·메서드·선언된 템플릿만). 같은 해시 재수신도 실행마다 행 유지 |
| `fin_source_records` | 업무 관측 단위 | `source_key` 있으면 `(계정, 키)` 유일. `null` 이면 미식별로 매번 보존(자동 확정 중복 제거 없음). **미식별 자료는 후속 업무 집계에 바로 사용할 수 없다** |
| `fin_source_record_versions` | 관측 버전 | 동일 키·변경 내용은 새 버전. 이전 payload 보존. 계정·실행·원본과 복합 FK 로 정합 |
| `fin_source_record_observations` | 실행별 관측 연결 | 내용이 같아 업무 버전이 늘지 않아도 (실행, 레코드, 관측한 버전, 원본) 연결을 매 실행 남김. 중복 제거(버전)와 추적 이력(연결)을 분리 |

복합 FK: 레코드의 계정 = 실행의 계정, 버전의 (레코드, 실행, 원본) 이 같은 계정·실행에 속함, 관측 연결도 동일. 각각 존재하는 ID 라는 이유만으로 잘못된 조합을 만들 수 없다.

금액 컬럼·손익 계산은 없다. FIN-01 의 자체 십진수 도구(`fin/FIN-01/verify/decimal.ts`)는 채택하지 않았다.

## 수집기 공통 인터페이스 (`src/collector/`)

`authenticate → request → validate → normalize → reconcile` 다섯 단계. 각 단계는 `OK | NOT_IMPLEMENTED(code) | FAILED(errorCode, kind)` 를 식별자만으로 반환한다(자유 문장 없음).

실행 순서와 상태 규칙(`runCollection`):

| 상황 | 상태 | `failure_kind` | 관측 저장 |
|---|---|---|---|
| 인증 FAILED 이고 kind=CREDENTIALS(자격 없음·무효·권한 부족) | BLOCKED | CREDENTIALS | 없음 |
| 인증 FAILED 이고 kind≠CREDENTIALS(인증 서버 타임아웃·일시 장애 등) 또는 인증 중 예외 | FAILED | TRANSIENT / PERMANENT / STORAGE / UNKNOWN (수집기 반환값 유지, 예외는 UNKNOWN) | 없음 |
| 정기(SCHEDULED) 실행에 미구현 수집기 지정 | PARTIAL | NOT_IMPLEMENTED (`SCHEDULED_REQUIRES_COMPLETE_COLLECTOR`, 외부 요청 전 거부) | 없음 |
| 어떤 단계든 NOT_IMPLEMENTED (검증 모드) | PARTIAL | NOT_IMPLEMENTED (+`stages` 에 단계·코드) | 없음 |
| 요청·검증·정규화·대조·저장 실패 | FAILED | TRANSIENT / PERMANENT / STORAGE / UNKNOWN | 없음(수신된 원본은 보관) |
| 다섯 단계 OK + 관측 저장 커밋 | SUCCEEDED | null | 있음 |

- 순서는 **정규화 → 대조 → 관측 저장** 이다. 대조 실패·미구현이면 원본·실행 이력은 보존하되 최신 관측은 갱신하지 않는다.
- 대조 성공 후 관측 저장과 SUCCEEDED 기록은 **하나의 트랜잭션**이다. 데이터가 저장되지 않았는데 SUCCEEDED 가 되거나, 실패 데이터가 최신 관측이 되는 상태가 없다.
- 네트워크 요청 성공만으로 SUCCEEDED 가 되지 않는다. `failure_kind` 로 재시도 로직이 영구 미구현·자격 부족을 반복 실행하지 않도록 원인을 구분한다. 실패 원인은 오류가 난 단계가 아니라 수집기가 반환한 `kind` 로만 판정한다.
- 실행 모드: `SCHEDULED`(기본, 정기 자동 수집)는 `implementedStages` 에 다섯 단계가 전부 선언된 수집기만 허용하며(`isSchedulable`), 미구현 수집기는 외부 요청 전에 PARTIAL 로 거부한다. `VERIFICATION` 은 FIN-01 검증 목적의 수동 실행에서만 명시적으로 지정하며, 결과는 PARTIAL/NOT_IMPLEMENTED 이고 최신 관측·손익·현금 집계에 반영되지 않는다. 기본값으로 활성화되지 않는다.
- `normalize` 의 결과 `payload` 는 공급자 원본 구조를 담는 `unknown` 이다. 공급자별 추정 필드를 공통 모델의 필수 사실로 고정하지 않는다.

## 오류 경계와 복구 (`src/collector/pipeline.ts`, `src/recovery.ts`)

- 실행 생성 이후 전체를 오류 경계로 감싼다. 원본 바이트 저장 실패 `RAW_STORE_FAILED`, 메타데이터 저장 실패 `RAW_META_FAILED`(고아 원본 후보), 관측 트랜잭션 실패 `OBSERVE_STORE_FAILED`(롤백)를 구분해 FAILED/STORAGE 로 기록한다.
- 종료 기록 자체가 실패하면 `finalized=false` 와 원래 실패 코드를 호출자에게 돌려주고, 실행은 RUNNING 으로 남아 복구 확인 후보가 된다.
- 로그 경계: 로그 콜백 예외는 `safeLog` 가 흡수하고 `logFailed=true` 로만 알린다. 로그 실패로 DB 의 성공·실패 상태를 다시 바꾸지 않으며, 종료 기록이 성공했다면 `finalized=true` 를 유지한다. 로그 오류를 같은 로그 함수로 다시 출력하지 않는다. 로그 장애(`logFailed`)와 DB 종료 기록 장애(`finalized=false`)는 별도 신호다.
- 수동 복구 정책(확정): 자동 실패 마감·잠금 탈취는 없다. 60분 이상 RUNNING 인 실행과 heartbeat 2분 초과 잠금은 **확인 후보**로만 조회한다(`listStaleRunCandidates`, `previewRecovery`; 실행 ID·시작 시각·소유자 worker_id·세대값·heartbeat 상태·`closeArgs` 를 함께 제시). 마감에는 담당자의 명시적 확인 입력(`verified: OWNER_TERMINATED | NO_ACTIVE_WORK`)과 사유가 필요하며, heartbeat 노후는 이를 대체하지 않는다(없으면 `CONFIRMATION_REQUIRED`). 적용(`closeStaleRunManually`)은 한 트랜잭션에서 **잠금 행 → 실행 행** 순서로 `FOR UPDATE` 한 뒤 상태 RUNNING·시작 시각·세대값을 재확인한다. worker 커밋(`assertLeaseHeld` → `finishRun`)도 같은 순서라 둘은 직렬화된다: 정상 완료가 먼저면 `NOT_RUNNING`, 소유권이 바뀌었으면 `OWNERSHIP_CHANGED`, heartbeat 가 최근이면 `OWNER_ALIVE` 로 거부. 복구가 먼저 확정되면 실행은 FAILED, 같은 세대 잠금은 해제, 작업은 NEEDS_REVIEW, 시도는 MANUAL_CLOSE 로 닫히고 이전 worker 의 관측 커밋·종료 갱신·heartbeat 는 모두 0행이다. 고아 원본·바이트 유실은 목록만 제시하고 삭제하지 않는다. 시험: `test/recovery-contention.test.ts`.
- 큐 등록 경계(FIN-02C 보완): `enqueueCollection` 은 DB 작업 생성 → 큐 등록 → `queued_at` 기록 순서다. 등록 실패는 `QUEUE_REGISTRATION_FAILED`(작업은 DB 에 남음), 응답 유실 후 같은 요청 재전송은 `DUPLICATE_REQUEST_ID`(+ `queued_at` 이 비어 있으면 같은 jobId 로 재등록), 같은 요청 ID 를 다른 내용으로 쓰면 `REQUEST_ID_CONFLICT`. `resyncUnqueuedJobs`(`pnpm enqueue --resync`)가 `queued_at IS NULL` 인 QUEUED/RETRY_SCHEDULED 작업을 재등록한다. 완료된 작업의 재전달은 worker 가 상태 검사에서 SKIPPED 로 끝내며 외부 요청을 시작하지 않는다. 잠금 대기(DEFERRED)는 시도를 시작하지 않아 재시도 횟수를 소진하지 않는다. 시험: `test/queue-boundary.test.ts`. 재시도 예정 시각(`next_attempt_at`)은 DB 시각 기준으로 `beginAttempt` 의 조건부 UPDATE 가 최종 방어하며, 예정 전 조기 전달은 시도·외부 요청 없이 예약을 보존·재예약한다(`NOT_DUE`). 시험: `test/retry-schedule.test.ts`.
- readiness(`/health/ready`)는 마이그레이션 "개수" 가 아니라 `src/db/migrations.ts` 의 `REQUIRED_MIGRATIONS` 집합이 전부 적용됐는지 확인한다. 이전 단계 스키마는 `SCHEMA_OUTDATED` + 누락 개수로 503 이며 연결 문자열·DB 이름·파일명은 응답에 없다.
- 프로세스 강제 종료·DB 장애는 try/catch 로 해결되지 않는다. 재처리는 새 실행으로 하며, 원본 키에 실행 ID 가 포함되고(`wx` 쓰기) 관측 저장이 (계정, 키, 해시) 기준 멱등이라 중복 부작용이 없다.

## 비밀값 취급 경계 (`src/redact.ts`)

"정규식으로 모든 비밀값을 탐지한다" 는 보장 대신 영속화·로그에 허용되는 메타데이터를 제한한다.

- 요청 요약은 `{원천 시스템, 메서드, 엔드포인트 템플릿}` 만 저장한다. 템플릿은 수집기가 **상수로 선언한 목록**(`endpointTemplates`)의 원소와 정확히 일치해야 하고, 형태 규칙(`?`, `=`, `&` 금지)을 만족해야 하며, 이번 실행에서 읽은 비밀값을 포함하면 안 된다. 위반 시 원본을 저장하지 않고 `REQUEST_SUMMARY_INVALID` 로 실패한다. 실제 URL·헤더 값은 받지도 저장하지도 않는다.
- 오류는 내부 코드와 코드별 고정 설명(카탈로그), 예외 클래스명만 저장한다. 외부 예외 메시지는 영속화·로그하지 않는다. `note` 는 파이프라인이 만든 고정 문장만 담는다.
- 인증 응답은 원본 저장 경로로 보내지 않는다. 업무 응답이 이번 실행에서 사용한 인증값을 반사하거나(`RAW_CONTAINS_CREDENTIAL`) 토큰 성격 필드를 포함하면(`RAW_TOKEN_FIELD`) 원본 저장을 중단하고 실패로 기록한다.
- 정상 업무 응답은 바이트를 변경하지 않고 보존한다. 마스킹한 파일을 원본으로 저장하지 않는다.
- `redactText` 는 로그 한 줄 조립 시의 보조 방어선이며 정책의 근거가 아니다.

## 검증 (`test/completion-cases.test.ts`, `test/remediation.test.ts`)

시험용 일회용 PostgreSQL + 가상 데이터로 완료 기준 8건, 2차 검토 회귀 12건, 3차 검토·정책 회귀 7건(`test/final-fixes.test.ts`), FIN-02B 7건, FIN-02C 10건 + 복구 경합 5건 + 큐 경계 7건 + 잠금 1건, 환율 수집기 내부 시험 5건을 검증한다(총 62건). **외부 공급자 연동 성공을 뜻하지 않는다.** 결과 로그는 `evidence/test.log`. DB 장애는 SQL 패턴에 따라 예외를 던지는 풀 래퍼(`test/helpers.ts` `faultyPool`)로 주입한다.

## 남은 제약·설계 결정 필요 사항

- NestJS 앱은 루프백 전용이며 로그인·인가 전 배포 대상이 아니다. 수집 실행 HTTP API·스케줄러·큐·heartbeat·실행 잠금 미구현.
- 원본 저장소는 파일 시스템 구현(`FsRawStore`)이며 운영은 비공개 객체 저장소로 교체한다(인터페이스 동일).
- 로그인·작업 큐(BullMQ+Redis)·실제 공급자 수집기·표준 거래 정규화·금액 정밀도 라이브러리 선택은 미착수.
- 실행 이력의 동시 실행 잠금(계획서 §10)은 미구현.
- 미식별 레코드의 중복 후보 검토 규칙·매칭 UI 는 미구현(이 범위 밖).
