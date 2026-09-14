# FIN-02B 제출: NestJS 실행 기반 및 독립 검사 구성

- 상태: **READY_FOR_REVIEW** (FIN-02B 에 한함). FIN-02A 는 최종 보완 커밋 후 별도 READY_FOR_REVIEW. FIN-01 실제 연동 미검증 상태 유지.
- 범위: 기존 독립 패키지에 NestJS 앱 구성, 설정 검증, DB 연결 모듈, liveness/readiness, 기존 수집·복구 모듈 의존성 구성, 독립 typecheck·lint·format·test, 독립 CI 검사, 수동 복구 CLI. **금융 데이터 조회 API·로그인·수집 큐·스케줄러·대시보드·실제 공급자 연결은 없다.** 이미 검증한 핵심 로직(pipeline/observe/recovery/repo)은 재작성하지 않고 주입만 했다.
- 앱은 루프백 인터페이스에만 바인딩한다. 설정 검증이 `127.0.0.0/8`, `::1`, `localhost` 외 호스트를 거부한다(로그인 구현 전 외부 공개 금지).

## 1. 변경 파일

| 경로 | 내용 |
|---|---|
| `src/app/tokens.ts` | DI 토큰. esbuild(tsx·vitest)가 `emitDecoratorMetadata` 를 지원하지 않아 타입 기반 주입 대신 명시적 `@Inject` 토큰만 사용 |
| `src/app/config.ts` | 설정 검증(`FIN02A_DATABASE_URL` 필수·형식, 루프백 호스트만 허용, 포트·복구 임계 분 검증). 연결 문자열은 로그·응답에 미노출 |
| `src/app/db.module.ts` | `DB_POOL` 제공(기존 `createPool`), 종료 시 풀 정리, readiness 용 `DbHealthService`(고정 코드 DB_UNREACHABLE/SCHEMA_MISSING/DB_TIMEOUT) |
| `src/app/health.controller.ts` | `GET /health/live`(항상 200), `GET /health/ready`(DB·스키마 확인, 실패 시 503 + 고정 코드) |
| `src/app/collection.module.ts` | `RAW_STORE`(FsRawStore), `SECRETS`(환경변수 제공자), `CollectionService`(기존 `runCollection` 호출), `RecoveryService`(기존 `previewRecovery`/`closeStaleRunManually`) |
| `src/app/app.module.ts`, `src/app/main.ts` | 모듈 조립, 부트스트랩(`createApp` 은 테스트 재사용). 설정 오류는 코드만 출력 |
| `scripts/recovery.ts` | 수동 복구 CLI: `preview` / `close … [--confirm]`(미리보기·드라이런·적용 분리) |
| `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `package.json`(scripts·devDeps), `tsconfig.json`(데코레이터 옵션), `pnpm-lock.yaml` | 독립 검사 구성 |
| `test/app.test.ts` | 설정 검증, liveness/readiness 3상황, 복구 CLI 5건 |
| 루트 `tsconfig.json`, `eslint.config.ts`, `.github/workflows/ci.yml` | §5 대응표 참조 |

## 2. 실행 방법

```bash
cd fin/fin02a
pnpm install --frozen-lockfile --ignore-workspace
scripts/dev-db.sh start            # 또는 docker compose -f docker-compose.fin.yml up -d
export FIN02A_DATABASE_URL=postgresql://fin02a@127.0.0.1:5433/postgres
pnpm db:migrate                    # 개발 DB 에 0001~0003 적용
pnpm verify                        # typecheck → lint → format:check → test
pnpm start:dev                     # 127.0.0.1:3400 (FIN02A_HTTP_HOST/PORT 로 변경, 루프백만 허용)
curl -s http://127.0.0.1:3400/health/live
curl -s http://127.0.0.1:3400/health/ready
pnpm recovery preview --minutes 60
pnpm recovery close --run <id> --started-at <preview 의 startedAt> --actor <담당자> --reason "<확인 내용>"            # 드라이런(종료 코드 3)
pnpm recovery close --run <id> --started-at <…> --actor <담당자> --reason "<확인 내용>" --confirm                  # 적용
```

## 3. 수동 복구 미리보기·적용 검증 (`test/app.test.ts`, `test/final-fixes.test.ts`)

| 검증 | 결과 |
|---|---|
| `preview` 는 후보·고아 원본·유실을 출력하고 상태를 바꾸지 않음 | 통과(후보 조회 후에도 RUNNING 유지) |
| `close` 는 `--confirm` 없으면 드라이런(종료 코드 3, 변경 없음) | 통과 |
| 필수 인자 누락 시 사용법 오류(종료 코드 2) | 통과 |
| `--confirm` 적용 시 FAILED/RECOVERY_MANUAL_CLOSE, `closed_by`·`close_reason` 기록 | 통과 |
| 이미 종료된 실행·시작 시각 변경 시 미적용(종료 코드 4) | 통과 |
| 정상 장기 실행은 시간 경과만으로 종료되지 않음(후보로만 조회) | 통과 |
| CLI 출력에 연결 문자열 없음 | 통과 |

## 4. liveness·readiness 및 DB 연결 실패 검증

| 상황 | live | ready | 응답 |
|---|---|---|---|
| 정상(시험용 DB, 마이그레이션 3개) | 200 | 200 | `{status:'ready', checks:[{database ok, migrations ≥ 3}]}`, 포트·호스트 미포함 |
| DB 연결 실패(닫힌 포트) | 200 | 503 | `{status:'not_ready', checks:[{database down, code DB_UNREACHABLE}]}`, ECONNREFUSED·호스트·사용자 미포함 |
| DB 연결되나 fin_ 스키마 없음(서버 기본 DB) | — | 503 | `code SCHEMA_MISSING` |
| 설정: 비루프백 호스트(`0.0.0.0`, `10.0.0.5`) | 부트스트랩 거부 | — | `NON_LOOPBACK_HOST` |

## 5. 루트 제외 범위와 독립 검사 대응표

| 검사 | 루트(SCM/WMS + fin/FIN-01) | fin/fin02a 독립 검사(CI `fin02a` 잡) |
|---|---|---|
| TypeScript | 루트 `tsconfig.json` `exclude` 에 `fin/fin02a/**` 추가(데코레이터 옵션 충돌 회피). `fin/FIN-01/**`·SCM/WMS 는 계속 포함 | `pnpm typecheck` (`tsconfig.json`: strict 동일 + `experimentalDecorators`/`emitDecoratorMetadata`) |
| ESLint | 루트 `eslint.config.ts` `globalIgnores` 에 `fin/fin02a/**` 추가. `fin/FIN-01/**` 계속 포함(확인: `eslint fin/FIN-01` 실행됨) | `pnpm lint` (`eslint.config.mjs`: `@eslint/js` recommended + `typescript-eslint` recommended + prettier, unused-vars·type-imports 규칙) |
| Prettier | 루트 `format:check` 는 **fin/fin02a 도 계속 포함**(충돌 없음, 조정하지 않음) | `pnpm format:check` (`.prettierrc.json` 은 루트와 동일 옵션, tailwind 플러그인만 없음) |
| 테스트 | 루트 vitest 는 원래 `src/**`·`tests/**` 만 수집(변경 없음) | `pnpm test` (시험용 PostgreSQL 서비스 컨테이너, `FIN02A_DATABASE_URL`) |
| CI | 기존 `verify` 잡 유지(변경 없음) | 신규 `fin02a` 잡: postgres:16-alpine 서비스, `pnpm install --frozen-lockfile --ignore-workspace`, typecheck → lint → format:check → test |
| 미변경 | 기존 SCM/WMS DB·Prisma·업무 코드·배포 구성·`.env*` | — |

제외와 독립 검사 추가는 같은 커밋에 있다. 어떤 코드도 검사에서 빠지지 않는다(루트 tsc/eslint 제외분은 CI `fin02a` 잡이, prettier 는 양쪽이 검사).

## 6. 필수 검증 결과

`evidence/` 로그 참조(명령·종료 코드 포함).

| 명령 | 종료 코드 | 결과 |
|---|---|---|
| `pnpm test` (fin/fin02a) | 0 | 4 파일 32 테스트(완료 기준 8 + 회귀 12 + 최종 보완 7 + FIN-02B 5) |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` (fin/fin02a) | 0 / 0 / 0 | — |
| 루트 `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | 0 / 0(기존 경고 4) / 0 | fin/fin02a 제외 후에도 통과, fin/FIN-01 은 루트 lint 대상 유지 |

CI `fin02a` 잡은 저장소 푸시 후 GitHub Actions 에서 실행되며, 본 환경에서는 워크플로 문법·명령 동일성만 로컬 재현으로 확인했다(Actions 결과는 검토 시 확인 필요).

## 7. 남은 제약

- 로그인·인가가 없으므로 앱은 루프백 전용이며 배포 대상이 아니다.
- 수집 실행을 HTTP 로 트리거하는 API 는 없다(`CollectionService` 는 코드 주입용). 스케줄러·큐·heartbeat·실행 잠금 미구현(자동 마감은 그 이후).
- 실제 공급자 수집기 없음. `implementedStages` 를 전부 선언한 수집기가 아직 없으므로 정기 실행 가능한 소스는 0개.
- `emitDecoratorMetadata` 를 쓰지 않으므로 이후 모듈도 명시적 토큰 주입을 유지해야 한다.
