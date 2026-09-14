# FIN-02A 보완결과

- 대상: 2차 코드 검토에서 확인된 결함 5건과 상태 정의 정리. 커밋 `591ad87` 이후의 보완이며 새 커밋은 대화 보고에 명시.
- 상태: **FIN-02A READY_FOR_REVIEW**(3차 검토 지적 2건과 확정 정책 반영 후 최종 검토 대상, §7). **FIN-01 READY_FOR_REVIEW**(비밀값 노출 경로만 수정, 연동 구현 확대 없음). FIN-02B·NestJS·로그인·큐·실제 공급자 수집기 미착수.
- 검증은 시험용 일회용 PostgreSQL 과 가상 데이터 기준이며 외부 연동 성공을 뜻하지 않는다. 실제 인증정보는 사용하지 않았다.

## 1. 지적 항목별 변경·검증·남은 제한

| # | 지적 | 변경 | 검증 | 남은 제한 |
|---|---|---|---|---|
| 2 | 비밀값 노출: `shownUrl` 쿼리만 제거, ECOS 키가 경로에 잔존, `redactUrl` 경로 미처리, note 무가공, 응답 본문 무검사 | **FIN-01** `verify/live/http.ts`: 실제 URL 을 어디에도 기록하지 않고 호출자가 선언한 템플릿(`LIVE_ENDPOINT_TEMPLATE`, ECOS 는 `{authkey}` 자리표시자)만 결과·로그에 남김. 외부 예외 메시지는 내부 코드(EGRESS_BLOCKED/DNS_FAILED/…)로 분류. **FIN-02A** `src/redact.ts` 재작성: 요청 요약은 `{원천, 메서드, 템플릿}` 만, 템플릿은 수집기 상수 목록(`Collector.endpointTemplates`)과 정확 일치 + 형태 규칙 + 이번 실행에서 읽은 비밀값 미포함(`TrackingSecrets`). 오류는 코드·카탈로그 설명·예외 클래스명만(`src/runs/repo.ts`). `note` 는 파이프라인 고정 문장만. 응답이 사용한 인증값을 반사하거나 토큰 필드를 포함하면 원본 저장 중단(`RAW_CONTAINS_CREDENTIAL`, `RAW_TOKEN_FIELD`). 정상 응답 바이트는 무변경 보존 | FIN-01: 가짜 키를 환경변수로 넣고 `--live fx-ecos` 실행 → `results/live-run.json` 에 키 부재(`evidence/`). FIN-02A: `remediation.test.ts` "2. 비밀값 경계" — 조립 경로, 키 포함 "상수" 템플릿, 쿼리 템플릿, 외부 예외 메시지, 본문 반사, 토큰 필드 각각 주입 → DB 덤프·원본 파일·로그·반환값에 부재. 완료 기준 8 도 예외 메시지 경로 추가 | 비밀값이 아닌 개인정보(구매자명 등)의 로그 마스킹(계획서 §10)은 이 범위 밖. 원본 바이트 자체는 무변경이므로 응답에 개인정보가 있으면 원본 저장소 접근 통제로 다뤄야 함 |
| 3 | 저장 오류 시 실행이 RUNNING 잔존 | `src/collector/pipeline.ts`: 실행 생성 이후 전체 오류 경계. `RAW_STORE_FAILED`(바이트) / `RAW_META_FAILED`(메타데이터, 고아 원본 후보 키를 note 에) / `OBSERVE_STORE_FAILED`(트랜잭션 롤백) 구분, FAILED/STORAGE 기록. 종료 기록 실패 시 `finalized=false` + 원래 코드 반환. `src/recovery.ts`: 미종료 실행 식별·마감, 고아 원본·바이트 유실 식별 | "3. 저장 실패와 미종료 실행" 4건: 실패 저장소 주입, `INSERT INTO fin_raw_objects` 실패 주입, `INSERT INTO fin_source_record_versions` 실패 주입, `UPDATE fin_source_runs` 실패 주입(+강제 종료 흉내 실행) | 프로세스 강제 종료는 try/catch 로 해결되지 않으며 복구 절차로만 식별. 분산 잠금·자동 재시도 스케줄러 미구현 |
| 4 | 대조 전 관측 갱신 | 순서를 정규화 → 대조 → 관측 저장으로 변경. 대조 FAILED/NOT_IMPLEMENTED 면 관측 미갱신. 관측 저장 + SUCCEEDED 기록을 단일 트랜잭션으로 | "4. 대조를 통과한 데이터만 최신 관측": v1 존재 상태에서 변경 응답 대조 실패 → current_version 1·last_run 유지·버전 1개. 대조 미구현도 동일. SUCCEEDED 실행은 항상 관측 연결 보유. 완료 기준 6 을 새 기준으로 수정 | — |
| 5 | 동일 내용 재수집 시 중간 실행 추적 불가 | `fin_source_record_observations` 테이블 신설(실행, 계정, 레코드, 관측한 버전, 원본, 결과). `observe()` 가 UNCHANGED 포함 매 실행 연결 행 기록. `traceRun`, `runsForRecord` 추가 | "5. 실행별 관측 연결": 3회 수집 → 버전 1 유지, 연결 3건(INSERTED, UNCHANGED, UNCHANGED), 각 실행의 원본 상이. 완료 기준 1 에 연결 4건 검증 추가 | — |
| 6 | 매핑 기간 중복 허용, 시스템·계정·실행 조합 미검증 | `0002_fin02a_integrity.sql`: EXCLUDE(btree_gist) 로 같은 범위 기간 중복 거부(계정/시스템 범위 공존 유지). 매핑 (계정, 시스템) 복합 FK. 실행 UNIQUE(id, 계정); 레코드 first/last run 복합 FK; 버전에 계정 컬럼 추가 후 (레코드,계정)·(실행,계정)·(원본,실행) 복합 FK; 관측 연결도 동일 | "6. 매핑·연결 무결성" 3건: 겹침·인접·범위 공존, 시스템 불일치 거부, 교차 계정·실행 조합 4종 거부 | `resolveExternalCode` 는 계정 범위 우선 후 `valid_from DESC` 인데, 중복이 차단되므로 한 시점에 범위당 최대 1건 |
| 7 | 요청 미구현 BLOCKED, 문서와 불일치, 미식별 범위 | BLOCKED=자격·권한 부족(인증 FAILED/CREDENTIALS)만. 미구현은 전 단계 PARTIAL + `stages` 에 단계·코드 + `failure_kind=NOT_IMPLEMENTED`. `failure_kind`(NOT_IMPLEMENTED/CREDENTIALS/TRANSIENT/PERMANENT/STORAGE/UNKNOWN) 컬럼 추가. 미식별 레코드는 후속 집계 불가 자료임을 README·코드 주석에 명시 | "7. 상태 정의": 5개 상황의 상태·원인 확인, 미식별 별도 보존 | 매칭 UI·임의 중복 제거 미구현(지시대로) |

## 2. 완료 기준 8건의 유지·수정 내역

| # | 유지/수정 | 내용 |
|---|---|---|
| 1 | 유지 + 보강 | 원거래 2건 2회 수집 = 관측 2·버전 2 는 올바른 결과로 유지. 실행별 연결 4건 검증 추가 |
| 2 | 유지 | — |
| 3 | 유지 | — |
| 4 | 유지 | 미식별 재보존 유지(설계 결정) |
| 5 | 유지 | — |
| 6 | **수정** | 요청 미구현 → PARTIAL/NOT_IMPLEMENTED(구 BLOCKED), 대조 미구현 → 관측 미저장(구 저장), `failure_kind`·단계 코드 검증 추가 |
| 7 | 유지 | — |
| 8 | **수정** | 토큰을 `ctx.secrets` 경유로 읽도록 시험 수집기 변경, 외부 예외 메시지 경로·반환값 검사 추가, 요청 요약이 템플릿만인지 검증 |

## 3. 실행 명령·종료 코드·결과

`evidence/` 참조(각 로그에 명령·시작/종료·종료 코드 포함).

| 명령 | 종료 코드 | 결과 |
|---|---|---|
| `pnpm test` (fin/fin02a) | 0 | 2 파일 20 테스트 통과(완료 기준 8 + 회귀 12) |
| `pnpm typecheck` (fin/fin02a) | 0 | — |
| 루트 `pnpm typecheck` / `eslint fin/fin02a fin/FIN-01` / `pnpm format:check` | 0 / 0 / 0 | 루트 게이트 통과 |
| FIN-01 `--live fx-ecos` 가짜 키 | 2(의도) | `live-run.json` 에 키 부재, 엔드포인트는 `{authkey}` 템플릿 |

## 4. 변경 파일

- FIN-01: `verify/live/http.ts`, `verify/live/index.ts`, `verify/run.ts`, `results/live-run*.json`, `FIN-01_실행결과.md`(§8 비고), `README.md`.
- FIN-02A: `db/migrations/0002_fin02a_integrity.sql`(신규), `src/redact.ts`, `src/collector/types.ts`, `src/collector/pipeline.ts`, `src/runs/repo.ts`, `src/raw/store.ts`, `src/raw/repo.ts`, `src/records/observe.ts`, `src/records/trace.ts`, `src/recovery.ts`(신규), `src/index.ts`, `test/helpers.ts`, `test/completion-cases.test.ts`, `test/remediation.test.ts`(신규), `README.md`, `FIN-02A_제출.md`, `evidence/`.

## 5. 기존 저장소 영향

루트 설정·SCM/WMS 코드·DB·CI 변경 없음(`evidence/isolation.txt`). 루트 tsc/eslint/prettier 가 `fin/` 을 자동 포함하나 전부 통과.

## 6. 설계 결정이 필요한 사항

1. 대조 미구현 소스의 운영 방식: 현재는 PARTIAL 로 남기고 관측을 저장하지 않는다. 원문만 축적하는 기간을 허용할지, 대조 구현 전에는 실행을 아예 막을지.
2. 복구 절차의 실행 주체·주기(수동 CLI vs 스케줄러)는 FIN-02B 이후.
3. 미종료 실행 판정 임계 시간(현재 호출자가 지정).
4. 요청 요약 템플릿 형태 규칙(`?`, `=`, `&` 금지)이 실제 공급자 경로 표현에 충분한지는 첫 실제 수집기 구현 시 확인.

## 7. 3차 검토 반영(최종 보완, 커밋은 대화 보고에 명시)

| # | 지적/정책 | 변경 | 검증(`test/final-fixes.test.ts`) |
|---|---|---|---|
| 2 | 인증 중 네트워크 오류도 BLOCKED | 인증 FAILED 의 상태를 수집기가 반환한 `kind` 로만 결정: CREDENTIALS → BLOCKED/CREDENTIALS, 그 외(TRANSIENT/PERMANENT/STORAGE/UNKNOWN) → FAILED + 해당 kind 유지. 인증 중 예외 → FAILED/UNKNOWN(`UNHANDLED_AUTHENTICATE`). 미구현은 PARTIAL/NOT_IMPLEMENTED 유지. 단계만으로 원인을 추정하지 않음 | 자격 부족·인증 서버 일시 장애·인증 중 예외 각각 검증. BLOCKED 는 자격 부족 1건뿐 |
| 3 | 성공 커밋 후 로그 예외가 반환 결과를 바꿈 | `safeLog` 경계: 로그 콜백 예외를 흡수하고 `CollectionOutcome.logFailed` 로만 보고. 성공·실패 종료 모두 종료 기록 성공 시 `finalized=true` 유지. 로그 오류를 같은 로그 함수로 재출력하지 않음. 로그 장애와 DB 종료 기록 장애(`finalized=false`) 구분 | 성공 종료 후 로그 예외(DB SUCCEEDED·관측 포함·finalized=true), 실패 종료 후 로그 예외(호출 1회, finalized=true), 로그 장애+종료 기록 장애 동시(구분) |
| 4 | 복구 정책 확정 | 자동 마감 제거. `listStaleRunCandidates`(기본 60분, 조회만)·`previewRecovery`(상태 불변)·`closeStaleRunManually`(주체·사유 기록, 적용 직전 status/started_at 재확인, 불일치 시 미적용). 0003 마이그레이션에 `closed_by`, `close_reason`. 고아 원본·유실은 목록만 | 정상 장기 실행이 후보로만 조회되고 종료되지 않음. 입력 검증, 다른 경로로 종료된 실행 미적용, 시작 시각 변경 미적용, 정상 적용 시 주체·사유(비밀값 마스킹) 기록, 재적용 거부, 미존재 |
| 5 | 대조 미구현 소스 정책 확정 | 실행 모드 `SCHEDULED`(기본)/`VERIFICATION`. `Collector.implementedStages` 선언과 `isSchedulable` 로 정기 실행은 완전 구현 수집기만 허용, 미구현 수집기는 외부 요청 전 `SCHEDULED_REQUIRES_COMPLETE_COLLECTOR` 로 거부. 검증 모드는 명시적 지정이며 PARTIAL/NOT_IMPLEMENTED, 관측·집계 미반영. 0003 마이그레이션에 `mode` 컬럼 | 기본 모드 거부(요청 단계 SKIPPED, 원본 없음), 검증 모드 원본 수집·관측 0건, 완전 구현 수집기 정기 실행 성공 |

기존 시험 수정: 미구현 옵션을 쓰는 시험은 `mode: 'VERIFICATION'` 을 명시(정책 반영). 이전 `listUnfinishedRuns`/`markUnfinishedRunFailed`(자동 마감) 는 제거하고 후보 조회·수동 마감으로 대체. 총 27건 통과(`evidence/test.log`).
