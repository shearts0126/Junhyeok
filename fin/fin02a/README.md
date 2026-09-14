# FIN-02A: 원천 데이터 추적 및 수집 실행 기반

경영대시보드(딥포인트·디스트로바) 공통 기반의 첫 조각. 계획서 §5 의 `legal_entities` / `source_accounts` / `external_mappings` / `source_runs` / `raw_objects` / `source_records` 에 해당하며, 외부 API 형식과 무관한 부분만 구현한다.

**이 범위는 FIN-02 전체가 아니다.** 로그인·작업 큐·실제 공급자 수집기·금액/손익 계산·화면·배포는 미착수다. FIN-01 최종 승인과도 별개다.

## 위치와 독립성

- 위치: `fin/fin02a/` (SCM/WMS 저장소 안, 별도 패키지). 루트 `package.json`·잠금 파일·tsconfig·eslint·CI·`src/`·`prisma/` 는 변경하지 않았다.
- 의존성: 자체 `package.json` + 자체 `pnpm-lock.yaml` + 자체 `node_modules` (`pnpm install --ignore-workspace`). 런타임 의존성은 `pg` 하나다. NestJS 는 이 조각(리포지토리·파이프라인 모듈)에 필요하지 않아 아직 추가하지 않았다(§"남은 제약").
- DB: FIN-02A 전용 PostgreSQL 16. 루트 `docker-compose.yml`(SCM/WMS, 5432)과 분리된 `docker-compose.fin.yml`(5433) 또는 로컬 바이너리(`scripts/dev-db.sh`). SCM/WMS 의 운영 DB·Prisma 마이그레이션은 사용·실행하지 않는다. 환경변수 이름도 `FIN02A_DATABASE_URL` 로 분리했다.
- 루트 품질 게이트: 루트 `tsconfig.json` 의 `include: **/*.ts` 와 `eslint .` 범위 때문에 이 폴더의 TypeScript 도 루트 typecheck·lint·format:check 에 자동 포함된다. 전부 통과(`evidence/`). 루트 vitest 는 `src/**`·`tests/**` 만 수집하므로 이 폴더의 테스트는 여기서 따로 실행한다.

## 실행

```bash
cd fin/fin02a
pnpm install --ignore-workspace          # 자체 node_modules

# 전용 DB (둘 중 하나)
docker compose -f docker-compose.fin.yml up -d     # 5433
#   또는 docker 가 없을 때: 로컬 PostgreSQL 16 바이너리(비루트 사용자로 initdb/pg_ctl)
scripts/dev-db.sh start                            # 출력된 FIN02A_DATABASE_URL 사용

export FIN02A_DATABASE_URL=postgresql://fin02a@127.0.0.1:5433/postgres
pnpm typecheck
pnpm test            # 일회용 DB fin02a_test_<pid> 생성 → 마이그레이션 → 8개 완료 기준 → DB 삭제
pnpm db:migrate      # 개발 DB 에 마이그레이션 적용(선택)
```

테스트는 DB 가 없으면 실패한다(조건부 skip 없음). 모든 테스트 데이터는 시험 전용이며 실제 계좌·판매자 계정이 아니다.

## 데이터 구조 (`db/migrations/0001_fin02a_core.sql`)

| 테이블 | 역할 | 핵심 규칙 |
|---|---|---|
| `fin_legal_entities` | 법인 | 코드 유일 |
| `fin_source_systems` | 원천 시스템 | 종류 BANK/SALES/DELIVERY/ADS/ACCOUNTING/FX |
| `fin_source_accounts` | 원천 계정과 소속 법인 | `(법인, 원천 시스템, 외부 계정 ID)` 유일. 다른 법인의 같은 외부 ID 는 충돌하지 않음. 별칭 유일 |
| `fin_external_mappings` | 외부 코드 → 내부 ID | 원천 시스템(+계정) 범위, 유효기간. 계정 범위가 시스템 범위보다 우선. 미매핑은 `null`(임의 생성 없음) |
| `fin_source_runs` | 수집 실행 이력 | 실행 ID, 계정, 대상 기간, 시작·종료, 상태(RUNNING/SUCCEEDED/PARTIAL/FAILED/BLOCKED), 단계별 결과(`stages`), 오류 코드·비식별 메시지, `source_as_of`(미제공 null), `received_count`(확인 못 하면 null, 실제 0건은 0) |
| `fin_raw_objects` | 원본 보관 | 바이트 무변경 저장(`storage_key`), sha256, 실행 ID, 수집 시각, 콘텐츠 유형, 요청 요약(메서드·비밀값 제거 URL·헤더 이름만). 같은 해시 재수신도 실행마다 행 유지 |
| `fin_source_records` | 업무 관측 단위 | `source_key` 있으면 `(계정, 키)` 유일. `null` 이면 미식별로 매번 보존(자동 확정 중복 제거 없음) |
| `fin_source_record_versions` | 관측 버전 | 동일 키·변경 내용은 새 버전. 이전 payload 보존. 원본 객체·실행으로 추적 |

금액 컬럼·손익 계산은 없다. FIN-01 의 자체 십진수 도구(`fin/FIN-01/verify/decimal.ts`)는 채택하지 않았다.

## 수집기 공통 인터페이스 (`src/collector/`)

`authenticate → request → validate → normalize → reconcile` 다섯 단계. 각 단계는 `OK | NOT_IMPLEMENTED | FAILED` 를 명시적으로 반환한다.

실행 상태 규칙(`runCollection`):

| 상황 | 상태 | `received_count` |
|---|---|---|
| 다섯 단계 전부 OK | SUCCEEDED | 관측 건수(0건이면 0) |
| 어떤 단계든 NOT_IMPLEMENTED(예: 원문 수신만) | PARTIAL | 검증 단계가 건수를 명시했으면 그 값, 아니면 null |
| 요청·검증·정규화·대조 실패 | FAILED | null(원문은 수신된 경우 보관) |
| 인증 실패·미구현 | BLOCKED | null |

네트워크 요청 성공만으로 SUCCEEDED 가 되지 않는다. `stages` 에 단계별 결과와 SKIPPED 가 남는다.

`normalize` 의 결과 `payload` 는 공급자 원본 구조를 담는 `unknown` 이다. 공급자별 추정 필드를 공통 모델의 필수 사실로 고정하지 않는다. 표준 거래(`sales_events` 등)로의 변환은 이 범위에 없다.

## 비밀값 처리 (`src/redact.ts`)

- 요청 헤더는 값 없이 이름만 저장. URL 쿼리의 토큰류 파라미터 값과 `Bearer …`, `key=…` 형태 문자열은 `[REDACTED]`.
- 실행 이력 오류 메시지와 파이프라인 로그는 저장·출력 전에 `redactText` 를 거친다.
- 완료 기준 8 이 저장 데이터 전체 덤프·원본 저장소·로그에서 시험용 토큰 부재를 검사한다.

## 완료 기준 검증 (`test/completion-cases.test.ts`)

시험용 일회용 PostgreSQL + 가상 데이터로 8개 사례를 검증한다. **외부 공급자 연동 성공을 뜻하지 않는다.** 결과 로그는 `evidence/test.log`.

## 남은 제약·설계 결정 필요 사항

- **NestJS 미도입**: 이 조각은 API 엔드포인트가 없어 NestJS 가 필요하지 않다. NestJS 앱(모듈·컨트롤러)을 붙이면 `experimentalDecorators`/`emitDecoratorMetadata` 가 필요한데, 루트 tsconfig 가 `fin/**/*.ts` 를 함께 컴파일하므로 **루트 `tsconfig.json`·`eslint.config.ts` 에 `fin/fin02a/**` 제외(각 1줄)** 가 필요하다. 이 루트 변경은 지시대로 먼저 보고하고 승인 후 적용한다. 대안은 저장소를 분리하는 것이다.
- 원본 저장소는 파일 시스템 구현(`FsRawStore`)이며 운영은 비공개 객체 저장소로 교체한다(인터페이스 동일).
- 로그인·작업 큐(BullMQ+Redis)·실제 공급자 수집기·표준 거래 정규화·금액 정밀도 라이브러리 선택은 미착수.
- 실행 이력의 동시 실행 잠금(계획서 §10)은 미구현.
