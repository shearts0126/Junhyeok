# FIN-02A 제출: 원천 데이터 추적 및 수집 실행 기반

- 상태: **READY_FOR_REVIEW** (FIN-02A 에 한함). FIN-02 전체 완료 아님. FIN-01 은 별도로 READY_FOR_REVIEW 유지.
- 브랜치 `claude/festive-dijkstra-i5llac`. 커밋은 대화 보고에 명시. 변경 파일은 전부 `fin/fin02a/` 하위(신규).
- 검증은 **시험용 일회용 PostgreSQL 과 가상 데이터** 기준이며 외부 연동 성공을 뜻하지 않는다.

## 1. 변경 파일

| 경로 | 내용 |
|---|---|
| `package.json`, `pnpm-lock.yaml`, `.npmrc`, `.gitignore`, `tsconfig.json`, `vitest.config.ts` | 자체 패키지(런타임 의존성 `pg` 만). 루트와 분리 |
| `docker-compose.fin.yml`, `scripts/dev-db.sh` | 전용 개발/시험 DB(5433). 루트 SCM/WMS DB 와 분리 |
| `db/migrations/0001_fin02a_core.sql`, `src/db/migrate.ts`, `scripts/migrate.ts` | 순수 SQL 마이그레이션과 적용기(Prisma 미사용) |
| `src/identity/repo.ts` | ① 법인·원천 시스템·원천 계정(소속 법인)·외부 코드 매핑 |
| `src/runs/repo.ts` | ② 수집 실행 이력 |
| `src/raw/store.ts`, `src/raw/repo.ts` | ③ 원본 보관(바이트 무변경, 해시·실행 ID·시각·콘텐츠 유형·요청 요약) |
| `src/records/observe.ts`, `src/records/trace.ts` | ④ 관측 버전·중복 처리, 처리 결과→원본→실행 추적 |
| `src/collector/types.ts`, `src/collector/pipeline.ts` | ⑤ 수집기 공통 인터페이스(5단계, 명시적 NOT_IMPLEMENTED)와 실행 파이프라인 |
| `src/redact.ts`, `src/hash.ts` | 비밀값 제거, 안정 해시 |
| `test/*.ts` | 완료 기준 8건(시험용 수집기·시험 데이터) |
| `README.md`, `evidence/` | 데이터 구조·실행 방법·로그 |

## 2. 데이터 구조

`README.md` §데이터 구조 표와 `db/migrations/0001_fin02a_core.sql` 참조. 계획서 §5 의 테이블 이름·규칙(원천키=시스템+계정+ID, ID 없으면 행 식별 보존, 재수집은 관측 버전 추가, 날짜·금액·적요만 같은 거래 삭제 금지)을 그대로 따르며 새 개념을 추가하지 않았다. 금액·손익 컬럼 없음.

## 3. 실행 방법

`README.md` §실행. 요약: `pnpm install --ignore-workspace` → 전용 DB 기동 → `FIN02A_DATABASE_URL` 설정 → `pnpm typecheck && pnpm test`.

## 4. 필수 검증 결과 (`evidence/test.log`)

| # | 완료 기준 | 결과 | 검증 방법(요약) |
|---|---|---|---|
| 1 | 동일 원본 2회 수집: 실행 이력 2회, 동일 고유키 관측 무중복 | 통과 | 실행 2행, 원본 객체 2행(같은 sha256), 레코드 2행·버전 2행 유지, 2차 결과 unchanged=2 |
| 2 | 동일 고유키 내용 변경: 이전·새 버전 모두 추적 | 통과 | current_version 2, 버전 1·2 의 payload 와 각자의 원본 객체 ID 확인 |
| 3 | 다른 법인·원천 계정의 같은 외부 ID 비충돌 | 통과 | 두 법인에 같은 외부 계정 ID·같은 원천키 저장, 계정 범위로 분리. 같은 법인·원천의 중복 계정은 유일 제약으로 거부. 매핑은 계정 범위 우선, 미매핑 null |
| 4 | 고유키 없는 동일 금액 거래 2건 비병합 | 통과 | 미식별 레코드 2행, 재수집 시 4행(자동 확정 중복 제거 없음) |
| 5 | 원천 기준 시각 미제공 vs 실제 0건 구분 | 통과 | 0건 응답: SUCCEEDED, received_count=0, source_as_of=null. 기준 시각 제공 시 저장. 파싱 전 종료: received_count=null |
| 6 | 네트워크·파싱 실패가 수집 완료로 표시되지 않음 | 통과 | 네트워크 실패 FAILED/NETWORK/원본 없음, 파싱 실패 FAILED/PARSE_FAILED/원본 보관, 인증 실패 BLOCKED, 정규화·대조 미구현 PARTIAL. SUCCEEDED 0건 |
| 7 | 처리 결과→수집 실행→원본 추적 | 통과 | 관측 버전 ID 로 원본 sha256·저장 키·실행·계정 별칭·법인 코드 조회, 저장된 바이트 크기·내용 일치 |
| 8 | 토큰·인증 헤더가 저장 데이터·로그에 없음 | 통과 | 시험용 토큰을 헤더·URL·오류 메시지에 주입 → DB 전체 덤프·원본 저장소·로그에 부재, 헤더는 이름만 저장, URL 쿼리 `[REDACTED]` |

실행: `vitest run` 8/8 통과, 종료 코드 0. 루트 게이트: `pnpm typecheck` 0, `eslint fin/fin02a` 0, `pnpm format:check` 0 (`evidence/root-*.log`).

## 5. 기존 SCM/WMS 영향

없음. 루트 `package.json`·잠금 파일·tsconfig·eslint·vitest·CI·`src`·`prisma`·환경변수 파일 변경 0건(`evidence/isolation.txt`). 루트 tsc/eslint/prettier 가 이 폴더를 자동 포함하지만 전부 통과하므로 CI 에 추가 실패 요인이 없다. 기존 DB·마이그레이션은 실행하지 않았다.

## 6. 남은 제약과 설계 결정 필요 사항

1. **NestJS 도입 시 루트 설정 변경 필요**: `fin/fin02a` 에 NestJS 앱을 추가하려면 데코레이터 컴파일 옵션이 필요하고, 루트 tsconfig 가 `fin/**/*.ts` 를 함께 검사하므로 루트 `tsconfig.json` `exclude` 와 `eslint.config.ts` `globalIgnores` 에 `fin/fin02a/**` 각 1줄 추가가 필요하다. 영향: 루트 CI 가 이 폴더를 더 이상 검사하지 않으므로 이 폴더의 자체 게이트를 CI 에 별도 잡으로 추가해야 한다. 승인 전 적용하지 않았다. 대안: 저장소 분리.
2. 실행 상태 정의(SUCCEEDED 는 5단계 전부 OK, NOT_IMPLEMENTED 는 PARTIAL)는 구현 기본값이며 설계 확정 대상.
3. 미식별 레코드의 중복 후보 검토 규칙(계획서 §5 "중복 후보 검토")은 이 범위에 없다. 후속 정의 필요.
4. 원본 저장소 운영 구현(비공개 객체 저장소), 동시 실행 잠금, 로그인, 작업 큐, 실제 공급자 수집기, 표준 거래 정규화, 금액 정밀도 라이브러리 선택: 미착수.
5. 이 코드의 `normalize` 출력은 공급자 원본 구조를 담는 `unknown` 이며, FIN-01 가상 스키마를 API 계약으로 확정하지 않았다.
