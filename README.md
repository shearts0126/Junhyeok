# DEEPPOINT SCM OS

구매·발주, 공급계획, 재고, WMS 실행, S&OP를 통합한 내부 SCM 운영 시스템.

> **현재 단계: `R1a-0 / T0-7` — 감사로그·시스템 설정**
> 업무 모듈은 아직 구현되지 않았습니다. 업무 모델(SKU·재고 등)도 아직 없습니다.
> 진행 상황은 [`docs/07_개발백로그와_테스트전략_v0.2.md`](docs/07_개발백로그와_테스트전략_v0.2.md) 참조.

---

## 기술 구성

| 영역 | 기술 | 도입 시점 |
|---|---|---|
| 애플리케이션 | Next.js 16 (App Router) + React 19 + TypeScript 5 | T0-1 ✅ |
| 스타일 | Tailwind CSS 4 + shadcn/ui | T0-1 ✅ |
| 패키지 매니저 | pnpm 10 | T0-1 ✅ |
| 코드 품질 | ESLint 9 (flat config) + Prettier 3 | T0-1 ✅ |
| 오류 처리 | 공통 오류체계 + request ID | T0-3 ✅ |
| 트랜잭션 | `withTransaction` (자동 재시도 없음) | T0-4 ✅ |
| 수량·금액 | Prisma Decimal + 변환 금지 ESLint 규칙 | T0-4 ✅ |
| 모듈 경계 | 재고 원장·잔고 직접 import 차단 (ESLint) | T0-5 ✅ |
| 테스트 | Vitest 3 | T0-1 ✅ (Testcontainers는 T0-9) |
| 데이터베이스 | PostgreSQL 16 + Prisma 7 (`@prisma/adapter-pg`) | T0-2 ✅ |
| 인증·권한 | Supabase Auth + 2겹 권한 가드 | T0-6 ✅ |
| 감사·설정 | 불변 감사로그(DB 트리거) + 시스템 설정 | T0-7 ✅ |
| 파일 저장 | Supabase Storage | T4-2 (R1a-4) |
| 잡 큐 | pg-boss + 전용 워커 | T4-1 (R1a-4) |
| 배포 | Vercel | — |

---

## 로컬 실행

### 사전 요구사항

- Node.js `>= 20.9.0` (개발 검증: v22.22.2)
- pnpm `>= 10` (개발 검증: v10.33.0)
- Docker + Docker Compose (로컬 PostgreSQL 16)

```bash
# pnpm 미설치 시
corepack enable && corepack prepare pnpm@10.33.0 --activate
```

### 실행

```bash
# 1. 의존성 설치 (postinstall 에서 prisma generate 가 자동 실행됩니다)
pnpm install

# 2. 환경변수 준비
cp .env.example .env.local

# 3. 로컬 PostgreSQL 기동
pnpm db:up

# 4. Prisma 상태 확인
pnpm prisma:validate     # 스키마 검증
pnpm prisma:status       # 마이그레이션 상태 (DB 연결 확인 포함)

# 5. 개발 서버
pnpm dev
```

- 애플리케이션: http://localhost:3000
- 헬스체크: http://localhost:3000/api/health

```bash
curl -s http://localhost:3000/api/health | jq
```

**정상 (HTTP 200)**

```json
{
  "status": "ok",
  "service": "deeppoint-scm-os",
  "version": "0.1.0",
  "environment": "development",
  "timestamp": "2026-08-06T05:14:59.314Z",
  "uptimeSeconds": 6,
  "checks": [{ "name": "database", "status": "ok" }]
}
```

**DB 연결 실패 (HTTP 503)**

```json
{
  "status": "down",
  "checks": [
    {
      "name": "database",
      "status": "down",
      "detail": "데이터베이스에 연결할 수 없습니다."
    }
  ]
}
```

`checks` 항목이 하나라도 `down` 이면 전체 `status` 가 `down` 이 되고 HTTP 503 을 반환합니다.

> ⚠️ **응답에는 연결 문자열·호스트·포트·비밀번호가 절대 포함되지 않습니다.**
> 실패 사유는 분류된 고정 문장만 노출합니다 (`src/shared/db/check.ts`).
> 이 규칙은 단위 테스트로 고정되어 있습니다.

점검 항목은 도입 시점에 따라 늘어납니다 — database(T0-2 ✅) / auth(T0-6) / storage·queue(R1a-4).

---

## 스크립트

| 명령 | 설명 |
|---|---|
| `pnpm dev` | 개발 서버 |
| `pnpm build` | 프로덕션 빌드 |
| `pnpm start` | 프로덕션 서버 |
| `pnpm typegen` | Next.js 라우트 타입 생성 (`LayoutProps` 등) |
| `pnpm typecheck` | `next typegen` + `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm lint:fix` | ESLint 자동 수정 |
| `pnpm format` | Prettier 적용 |
| `pnpm format:check` | Prettier 검사 (CI용) |
| `pnpm test` | Vitest 전체 (unit + db 프로젝트) |
| `pnpm test:unit` | 단위 테스트만 (DB 불필요, 파일 병렬) |
| `pnpm test:db` | DB 통합 테스트 (일회용 PostgreSQL 자동 기동, 직렬) |
| `pnpm test:watch` | Vitest watch |
| `pnpm test:e2e` | Playwright E2E (스텁 Supabase + next dev 자동 기동) |
| `pnpm prisma:drift` | schema ↔ migration history 불일치 검사 (불일치 시 exit 2) |
| **`pnpm verify`** | **typecheck → lint → format:check → test(unit+db) → build 전체 검증** |

### 데이터베이스

| 명령 | 설명 |
|---|---|
| `pnpm db:up` | 로컬 PostgreSQL 기동 (docker compose) |
| `pnpm db:down` | 중지 (데이터 유지) |
| `pnpm db:reset` | **중지 + 볼륨 삭제 후 재기동 (데이터 초기화)** |
| `pnpm db:logs` | DB 로그 |
| `pnpm prisma:validate` | 스키마 검증 |
| `pnpm prisma:generate` | Prisma Client 생성 (`pnpm install` 시 자동 실행) |
| `pnpm prisma:status` | 마이그레이션 상태 + DB 연결 확인 |
| `pnpm prisma:migrate` | 개발용 마이그레이션 생성·적용 (`prisma migrate dev`) |
| `pnpm prisma:deploy` | 운영용 마이그레이션 적용 (`prisma migrate deploy`) |
| `pnpm prisma:studio` | Prisma Studio |
| `pnpm db:seed` | 역할·권한 + 코드사전 시드 (재실행 안전, 단일 트랜잭션) |

> `typecheck` 가 `next typegen` 을 선행하는 이유: Next.js 16은 `LayoutProps` / `PageProps` 등
> 라우트 타입을 `.next/types` 에 생성합니다. `tsc` 단독 실행 시 이 타입을 찾지 못합니다.

---

## 테스트 구조와 CI (T0-9)

### unit / db 2개 Vitest 프로젝트

| 프로젝트 | 대상 | 병렬 | DB |
|---|---|---|---|
| `unit` | `*-db.test.ts` 를 제외한 전부 | 파일 병렬 | 없음 (대역만) |
| `db` | `src/**/*-db.test.ts` + `tests/db/**` | **직렬** | 일회용 PostgreSQL |

`db` 프로젝트는 `tests/db/global-setup.ts` 가 **일회용 PostgreSQL 을 자동 기동**하고
빈 DB 에 `prisma migrate deploy` 로 **migration history 를 전량 적용**한 뒤 테스트를
돌립니다 (`db push` 우회 없음 — "빈 DB → 전량 적용 재현"이 매 실행 검증됩니다).

- 기본은 **Testcontainers** (`postgres:16-alpine` — docker-compose 와 동일 버전).
  Docker 가 없으면 **실패합니다** — `DATABASE_URL` 유무로 skip 하던 구조는 제거됐습니다.
- Docker 를 쓸 수 없는 환경은 `DB_TEST_SERVER_URL` 로 **일회용 PostgreSQL 서버**를
  명시할 수 있습니다. 하네스는 그 서버에 `scm_test_<random>` DB 를 만들어 쓰고 DROP
  합니다 — 기존 DB 를 건드리지 않습니다. CI 는 이 변수를 쓰지 않습니다.
- 테스트는 `.env` 의 `DATABASE_URL` 을 읽지 않습니다 — 개발자·운영 DB 로 향하는
  경로가 구조적으로 없습니다.

`db` 프로젝트만 직렬인 이유(실측): db 파일들은 하나의 DB 를 공유하며 ① 정리 단계의
`audit_log` 트리거 DISABLE/ENABLE ② seed 행(singleton·공통코드) 변경·검증이 병렬에서
경합합니다 — 병렬 실행 시 seed upsert 유니크 충돌로 3건 실패를 재현했습니다. 파일 6개
직렬 합계가 수 초라 파일별 DB 격리의 복잡도 대비 이득이 없습니다. unit 프로젝트의
전역 직렬화는 제거되어 병렬입니다.

### CI (GitHub Actions — `.github/workflows/ci.yml`)

```text
checkout → pnpm(packageManager 고정) → node(.nvmrc 고정) → install --frozen-lockfile
→ prisma generate → typecheck → lint → format:check
→ test:unit → test:db(Testcontainers) → prisma:drift → build
```

- **drift 게이트**: `prisma migrate diff --from-migrations … --to-schema … --exit-code`.
  schema.prisma 를 바꾸고 migration 을 만들지 않으면 exit 2 로 CI 가 실패합니다.
  shadow DB 는 일회용 PostgreSQL 입니다 — 운영·스테이징 DB 를 shadow 로 쓰지 않습니다.
- CI 에는 DB·Supabase **secret 이 없습니다.** DB 는 Testcontainers, 인증이 필요한
  E2E 는 CI 필수범위가 아닙니다 (로컬 `pnpm test:e2e`).
- Docker 가 CI 에서 동작하지 않으면 `test:db` 가 실패합니다 — skip 으로 green 을
  만들지 않습니다.

---

## 폴더 구조

```
.
├─ docs/                        설계 문서 (v0.1, v0.2, CHANGELOG)
├─ prisma/
│  ├─ schema.prisma             모델 정의 (T0-2 시점 모델 없음)
│  └─ migrations/               마이그레이션 (모델 추가 시 생성)
├─ public/                      정적 자산
├─ src/
│  ├─ app/                      Next.js App Router
│  │  ├─ api/health/route.ts    헬스체크 엔드포인트
│  │  ├─ globals.css            Tailwind + shadcn/ui 디자인 토큰
│  │  ├─ layout.tsx             루트 레이아웃
│  │  └─ page.tsx               랜딩 페이지 (기동 확인용)
│  ├─ components/ui/            shadcn/ui 컴포넌트 (프로젝트 소유 코드)
│  ├─ generated/prisma/         Prisma Client (커밋 제외, 자동 생성)
│  ├─ lib/utils.ts              cn() 유틸
│  ├─ modules/                  도메인 모듈 → src/modules/README.md
│  └─ shared/                   공유 계층 → src/shared/README.md
│     ├─ env.ts                 환경변수 검증
│     ├─ health.ts              헬스체크 로직
│     ├─ db/                    Prisma 클라이언트 · 연결 점검 · withTransaction
│     ├─ decimal/               Decimal 안전 유틸 (수량·금액, 계산 컨텍스트 고정)
│     └─ errors/                공통 오류체계 · request ID · 로깅 · 자격증명 마스킹
├─ eslint-rules/                프로젝트 전용 ESLint 규칙·경계 설정
│  ├─ no-decimal-to-number.ts   Decimal → number 변환 차단 (타입 기반)
│  ├─ inventory-boundary.ts     재고 원장·잔고 모델 직접 import 차단
│  └─ __fixtures__/             규칙 테스트용 예제 (lint 대상에서 제외)
├─ tests/                       소스 트리 밖 테스트 (ESLint 규칙 등)
├─ AGENTS.md / CLAUDE.md        ⚠️ Next.js 자동 생성 (아래 참조)
├─ docker-compose.yml           로컬 PostgreSQL
├─ prisma.config.ts             Prisma CLI 설정 (DIRECT_URL)
├─ components.json              shadcn/ui 설정
├─ eslint.config.ts             ESLint flat config (jiti 로 TS 로딩)
├─ vitest.config.ts
└─ .env.example
```

> ⚠️ **`AGENTS.md` / `CLAUDE.md` 는 사람이 작성한 문서가 아닙니다.** `next dev` 가
> `node_modules/next/dist/server/lib/generate-agent-files.js` 로 자동 생성·재삽입합니다.
> 작업트리를 깨끗하게 유지하려고 저장소에 포함해 두었습니다.
> **Next.js 버전을 올린 뒤에는 이 두 파일의 diff 를 반드시 검토**하고 커밋하세요.
> 내용이 조용히 바뀌어도 CI 가 잡아주지 않습니다.

### 모듈 구조 규칙

각 도메인 모듈은 4계층을 따릅니다.

```
src/modules/<module>/
├─ domain/           엔티티·불변식·상태전이 (순수 함수)
├─ application/      유스케이스·트랜잭션 경계·권한·감사로그
├─ infrastructure/   Prisma 리포지토리, 외부 어댑터
└─ presentation/     Zod DTO, Route Handler, Server Action, 화면
```

**핵심 규칙**

1. 비즈니스 로직을 React 컴포넌트나 Route Handler에 직접 작성하지 않습니다.
2. 모듈 간 호출은 `application/` 의 공개 인터페이스를 통합니다.
3. 재고를 변경하는 모든 경로는 `InventoryPostingService` 를 통과합니다.
4. 현재고(`inventory_balance`)를 직접 수정하는 코드는 존재하지 않습니다.

상세는 [`docs/02_시스템_아키텍처와_모듈구조.md`](docs/02_시스템_아키텍처와_모듈구조.md) 참조.

### 재고 원장·잔고 모델 경계 (lint 강제)

`InventoryLedgerEntry` 와 `InventoryBalance` 의 직접 import 는 **lint 오류**입니다.

`inventory_ledger_entry` 는 불변 원장이고 `inventory_balance` 는 그 원장에서 파생된 캐시입니다.
두 테이블을 아무 곳에서나 읽고 쓸 수 있으면 원장을 거치지 않은 현재고 직접 수정이 생기고, 원장과
잔고가 어긋나며, 감사로그 없이 재고가 바뀝니다. `InventoryPostingService` 를 우회할 수 있는 첫
번째 문이 Prisma 모델 직접 import 입니다.

| 위치 | 접근 |
|---|:-:|
| `src/modules/inventory/infrastructure/**` | ✅ |
| Prisma 생성 코드 (`src/generated/**`) | ✅ |
| `prisma/**` (루트) | ✅ |
| `scripts/migration/**`, `scripts/data-migration/**`, `scripts/seed/**` (루트) | ✅ |
| 전용 테스트 fixture | ✅ |
| `src/modules/inventory/domain/**` | ❌ |
| `src/modules/inventory/application/**` | ❌ |
| `src/modules/inventory/presentation/**` | ❌ |
| 그 외 모든 모듈 | ❌ |

**허용 경로는 모두 저장소 루트 기준입니다.** 앞에 와일드카드를 둔 접미 glob 을 쓰면
`src/modules/orders/scripts/` 같은 폴더를 만들어 경계를 우회할 수 있습니다.

```
✅ prisma/seed.ts                                  루트
✅ scripts/data-migration/backfill.ts              루트, 승인된 하위 경로
❌ src/modules/orders/scripts/backfill.ts          중첩된 가짜 scripts
❌ src/modules/orders/prisma/seed.ts               중첩된 가짜 prisma
❌ src/modules/inventory/application/scripts/x.ts
❌ src/shared/prisma/helper.ts
❌ scripts/adhoc/backfill.ts                       승인되지 않은 하위 경로
```

> `scripts/` 는 아직 저장소에 없습니다. 전환·시드 스크립트가 생길 위치를 미리 열어 둔 것이며,
> 폴더를 만들지는 않았습니다. 다른 경로가 필요해지면 `INVENTORY_MODEL_ALLOWED_GLOBS` 에
> **명시적으로** 추가합니다.

같은 inventory 모듈 안이어도 infrastructure 밖에서는 막습니다. 영속성 세부사항이 도메인 규칙으로
새어 들어오면 계층 분리가 이름만 남습니다. 다른 업무 모듈은 inventory **application 계층의 공개
인터페이스**로만 조회·명령합니다.

```ts
// ❌ 차단 — named / alias / type-only / re-export / namespace / 상대경로
import { InventoryBalance } from '@/generated/prisma/client';
import { InventoryBalance as Balance } from '@/generated/prisma/client';
import type { InventoryLedgerEntry } from '@/generated/prisma/client';
export { InventoryBalance } from '@/generated/prisma/client';
import * as PrismaModels from '@/generated/prisma/client';
import { InventoryBalance } from '../../generated/prisma/client';

// ❌ 차단 — 동적 import·require 우회
await import('@/generated/prisma/client');
require('@/generated/prisma/client');

// ✅ 허용 — 다른 Prisma 모델·런타임 타입
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { Sku } from '@/generated/prisma/client';

// ❌ 차단 — 재고 모델 이름이 없어도 infrastructure 직접 참조는 막힙니다
import { repository } from '@/modules/inventory/infrastructure/repository';
import { repository } from '../../inventory/infrastructure/repository';
export * from '@/modules/inventory/infrastructure/repository';

// ✅ 허용 — 다른 모듈은 application 공개 인터페이스로
import { getAvailableStock } from '@/modules/inventory/application';
```

**재고 모델 이름이 import 문에 나타나지 않아도** 다른 위치에서 inventory infrastructure 를 직접
참조하면 차단됩니다. 영속성 계층을 직접 가져오면 결국 원장·잔고에 도달할 수 있고, application
공개 인터페이스 원칙이 무너집니다. infrastructure 내부의 상호 참조는 그 위치에서 규칙이 off 이므로
영향받지 않습니다.

`namespace import` 를 막는 이유: 이후 속성 접근(`PrismaModels.InventoryBalance`)으로 이름 차단을
그대로 우회할 수 있습니다. 동적 import 는 import 이름을 정적으로 확인할 수 없어 경로 전체를
막습니다 — 그래서 infrastructure 밖에서는 `PrismaClient` 를 동적으로 불러오는 것도 차단됩니다.

구성은 [`eslint-rules/inventory-boundary.ts`](eslint-rules/inventory-boundary.ts) 에 있으며, ESLint
기본 `no-restricted-imports`(정적 import·re-export)와 `no-restricted-syntax`(동적 import·`require`)만
씁니다. 커스텀 규칙을 추가하지 않았습니다.

테스트([`tests/eslint-rules/inventory-boundary.test.ts`](tests/eslint-rules/inventory-boundary.test.ts))는
**같은 config 배열을 그대로 재사용**합니다. 설정을 복제하면 테스트는 통과하는데 실제 lint 는
통과하는 상황이 생깁니다.

> ⚠️ 두 모델은 **아직 존재하지 않습니다**(업무 모델은 R1a-2). 규칙은 import 경로와 이름만 보므로
> 모델 없이 동작하며, fixture 로 검증합니다. 임시 모델은 만들지 않았습니다.

---

## shadcn/ui

`components.json` 이 설정되어 있어 다음 명령으로 컴포넌트를 추가합니다.

```bash
pnpm dlx shadcn@latest add table dialog form
```

> **참고**: 이 개발 환경에서는 `ui.shadcn.com` 이 네트워크 정책상 차단되어(HTTP 403)
> CLI `init` 을 실행할 수 없었습니다. 대신 **현재 버전의 shadcn/ui 규약과 호환되는 수동 초기 구성**
> (`components.json`, `src/lib/utils.ts`, CSS 토큰, Button)을 작성했습니다.
> CLI 산출물과 완전히 동일함을 보장하지는 않으므로, **네트워크가 열린 환경에서 `shadcn add` 를
> 한 번 실행해 호환성을 검증**해 주세요.

---

## 환경변수

`.env.example` 을 `.env.local` 로 복사해 사용합니다. `.env*` 는 커밋되지 않습니다(`.env.example` 만 예외).

| 변수 | 필수 | 용도 | 도입 |
|---|:-:|---|---|
| `DATABASE_URL` | ✅ | 애플리케이션 런타임 (**pooled**) | T0-2 |
| `DIRECT_URL` | ✅ | 마이그레이션·워커 (**direct**) | T0-2 |
| `APP_TIMEZONE` | | 업무일자 파생 기준 (`Asia/Seoul` 고정) | T0-1 |
| `ENABLE_ERROR_PREVIEW` | | **개발 전용** 오류 미리보기 라우트 활성화 | T0-3 |
| `NEXT_PUBLIC_SUPABASE_URL` 외 | | 인증 | T0-6 |
| `SUPABASE_STORAGE_BUCKET_*` | | 파일 저장 | T4-2 |
| `PGBOSS_DATABASE_URL` | | 잡 큐 | T4-1 |

`.env.example` 에는 **형식과 설명만** 있으며 운영 자격증명은 포함되지 않습니다.

### 환경 3분리 — development / staging / production (T0-9)

`NODE_ENV` 는 빌드 모드일 뿐 staging 을 표현하지 못하므로, 배포 환경은 **`APP_ENV`** 로
구분합니다 (`src/shared/env.ts` `loadAppEnv`).

| | development | staging | production |
|---|---|---|---|
| `APP_ENV` | (기본값) | **`staging` 명시 필수** | `production` |
| `NODE_ENV` | development | production | production |
| 키 정의 | `.env.example` | `.env.staging.example` | `.env.production.example` |
| 값 주입 위치 | 개발자 로컬 `.env.local` | 호스팅 환경변수 | 호스팅 환경변수 |
| app URL | `http://localhost:3000` | staging 도메인 | 운영 도메인 |
| database | 로컬 docker PG | **staging 전용** Supabase 프로젝트 | 운영 Supabase 프로젝트 |
| Supabase 인증 | 로컬/개발 프로젝트 | staging 전용 프로젝트 | 운영 프로젝트 |
| `ENABLE_ERROR_PREVIEW` | 선택 | ⛔ 금지 | ⛔ 금지 |

규칙:

- **환경 간 값이 섞이지 않습니다.** 각 환경은 별도 Supabase 프로젝트·별도 DB 를 쓰고,
  키 이름은 같되 값은 그 환경의 주입 위치에만 존재합니다.
- **staging·production 값은 저장소·CI 에 없습니다.** example 파일은 키 목록과 주입 위치
  정의일 뿐이며, 실제 값은 호스팅 환경변수로만 주입합니다.
- `APP_ENV=staging|production` 은 production 빌드(`NODE_ENV=production`)를 요구하며,
  잘못된 값·조합은 기동 시점에 `EnvironmentError` 로 거부됩니다.
- staging 은 **기본값이 될 수 없습니다** — 미설정 시 development(개발 빌드) 또는
  production(운영 빌드)이며, staging 은 항상 명시해야 합니다.
- **테스트·CI 는 이 값들과 무관합니다.** DB 통합 테스트는 하네스(`tests/db/harness.ts`)가
  만든 일회용 PostgreSQL 만 사용하고 `.env` 의 `DATABASE_URL` 을 읽지 않으므로, 운영
  자격증명이 local/test 에서 자동 선택되는 경로가 없습니다.

### `DATABASE_URL` 과 `DIRECT_URL` 을 분리하는 이유

| | `DATABASE_URL` | `DIRECT_URL` |
|---|---|---|
| 용도 | 애플리케이션 런타임 | `prisma migrate`, 워커 |
| 연결 | Supavisor **transaction pooler** (운영 포트 6543) | **직결** (포트 5432) |
| 지정 위치 | `PrismaClient` driver adapter (`src/shared/db/prisma.ts`) | `prisma.config.ts` |

Vercel 서버리스는 요청마다 인스턴스가 뜰 수 있어 커넥션이 폭증합니다. 런타임은 pooler를 경유해
이를 막고, DDL·prepared statement 가 제한되는 pooler 대신 마이그레이션은 직결을 씁니다.

> ⚠️ **파생 제약**: transaction-mode pooler 에서는 세션 락(`pg_advisory_lock`)이 동작하지 않습니다.
> 재고 동시성 제어는 반드시 **행 잠금(`SELECT ... FOR UPDATE`)** 으로 구현합니다 (R1a-2).

### Prisma 7 주의

Prisma 7 부터 `datasource` 의 `url` / `directUrl` 을 **스키마에 둘 수 없습니다.**
연결 URL 은 `prisma.config.ts`(마이그레이션)와 driver adapter(런타임)로 분리되었습니다.
상세는 [`docs/03_ERD와_Prisma스키마_v0.2.md` §7.0](docs/03_ERD와_Prisma스키마_v0.2.md) 참조.

### 마이그레이션

```bash
# 모델 추가 후
pnpm prisma:migrate --name add_user_table   # prisma/migrations/ 에 SQL 생성 + 적용
pnpm prisma:status                          # 적용 상태 확인
pnpm prisma:deploy                          # 운영 반영 (CI/배포)
```

T0-2 시점에는 **업무 모델이 없어 마이그레이션 파일도 없습니다.**
`prisma migrate dev` 는 `Already in sync, no schema change` 를 반환하는 것이 정상입니다.

### 데이터베이스 초기화

```bash
pnpm db:reset        # 볼륨 삭제 + 재기동 (모든 데이터 소실)
pnpm prisma:deploy   # 마이그레이션 재적용 (모델이 생긴 뒤)
```

---

## 트랜잭션

재고·발주·감사로그처럼 여러 테이블을 한 번에 바꾸는 작업은 `withTransaction` 을 통과합니다.
유스케이스가 `prisma.$transaction` 을 직접 부르면 옵션 기본값·오류 처리·클라이언트 주입 방식이
호출부마다 갈라집니다.

```ts
import { withTransaction } from '@/shared/db';

const header = await withTransaction(async (tx) => {
  const created = await tx.inventoryTransaction.create({ data });
  await tx.inventoryLedgerEntry.createMany({ data: entries });
  return created;                      // 반환 타입이 그대로 보존됩니다
});
```

옵션을 주는 경우:

```ts
await withTransaction(
  async (tx) => { /* ... */ },
  { isolationLevel: 'Serializable', timeout: 15_000, maxWait: 3_000 },
);
```

| 옵션 | 단위 | 미지정 시 |
|---|---|---|
| `maxWait` | ms | Prisma 기본값 (2000) |
| `timeout` | ms | Prisma 기본값 (5000) |
| `isolationLevel` | `ReadUncommitted` / `ReadCommitted` / `RepeatableRead` / `Serializable` | DB 기본값 (PostgreSQL 은 `ReadCommitted`) |

지정한 키만 Prisma 에 전달됩니다. 아무것도 주지 않으면 옵션 객체 자체를 넘기지 않아
Prisma·DB 기본값이 그대로 쓰입니다.

**동작 계약**

- callback 이 정상 반환하면 **commit**, 반환값을 그대로 돌려줍니다.
- callback 이 예외를 던지면 **rollback**, **원래 오류를 그대로 전파**합니다.
  감싸거나 변환하지 않으므로 호출부의 `instanceof` 검사가 그대로 동작합니다.
- callback 은 **정확히 한 번** 실행됩니다.

### 자동 재시도가 없는 이유

직렬화 실패(`40001`)·데드락(`40P01`)은 재시도로 해소되는 경우가 많지만, **이 계층에서는
재시도하지 않습니다.**

`withTransaction` 의 재시도는 callback **전체**를 다시 실행합니다. callback 안에 외부 API 호출,
파일 저장, 메시지 발행처럼 **롤백되지 않는 부작용**이 하나라도 들어오면 그 부작용이 중복
실행됩니다. DB 는 롤백되지만 이미 보낸 HTTP 요청은 되돌릴 수 없습니다.

재시도는 "무엇을 다시 해도 안전한가"를 아는 계층이 결정해야 합니다. 따라서
`SERIALIZATION_FAILURE` 변환과 Posting Service 의 재시도 정책은 **멱등성 정책과 함께 R1a-2**
에서 구현합니다.

### 트랜잭션 클라이언트

callback 이 받는 `TransactionClient` 에는 `$transaction` · `$connect` · `$disconnect` · `$on` ·
`$use` · `$extends` 가 없습니다(Prisma 의 `ITXClientDenyList`). 중첩 트랜잭션과 커넥션 조작을
타입 수준에서 막습니다.

> ⚠️ callback 안에서 `getPrismaClient()` 를 다시 부르면 **트랜잭션 밖의 별도 커넥션**으로
> 나갑니다. 반드시 인자로 받은 `tx` 를 쓰세요.

---

## 수량과 금액 — Decimal

수량과 금액은 **끝까지 `Decimal` 로 다룹니다.** 중간 계산에서 한 번이라도 JavaScript `number` 로
내려가면 그 시점에 정밀도가 깨지고, 되돌릴 수 없습니다.

```
0.1 + 0.2 === 0.30000000000000004     // number
9007199254740993 → 9007199254740992   // 2^53 초과 정수는 표현 불가
```

재고 원장은 **불변**이고 현재고는 원장의 합으로 계산됩니다. 한 건의 오차가 모든 후속 잔고에
누적되며, 원장을 고칠 수 없으므로 정정거래로만 바로잡을 수 있습니다.

### 경계별 처리 원칙

| 경계 | 표현 | 이유 |
|---|---|---|
| DB (Prisma) | **Decimal 그대로** | Prisma 가 `numeric` 으로 그대로 전달합니다. 문자열로 바꾸지 않습니다 |
| 도메인·계산 | **Decimal 유지** | 중간 변환이 오차의 시작점입니다 |
| API 응답(JSON) | **문자열** | 클라이언트의 `JSON.parse` 가 double 로 읽어 정밀도를 잃습니다 |
| 로그 | 문자열 | |
| 파일(CSV·Excel) | 문자열 | 지수표기·자동 서식 변환을 피합니다 |
| 화면 표시 | 문자열 | 표시 서식은 프레젠테이션 계층 책임 |

### 유틸

```ts
import {
  toDecimal, isDecimal, toDecimalString,
  add, subtract, multiply, divide, sumDecimals,
  compareDecimals, isEqual, isGreaterThan, isLessThan, isZero, isNegative,
  roundToScale, ROUNDING, ZERO,
} from '@/shared/decimal';

const available = toDecimal('10.000000');
const requested = toDecimal('12.000000');

if (isLessThan(available, requested)) { /* 재고 부족 */ }

const remaining = subtract(available, requested);   // Decimal
return { available: toDecimalString(available) };   // 응답 경계에서만 문자열
```

입력 타입은 `Decimal | string` 입니다. **`number` 는 의도적으로 제외**했습니다 —
`toDecimal(0.1 + 0.2)` 가 타입 수준에서 막혀야 정밀도 손실이 유틸 안으로 새어 들어오지 않습니다.

두 가지 함정을 유틸이 막습니다.

1. **0 으로 나누기** — decimal.js 는 예외 없이 `Infinity`(`0/0` 은 `NaN`)를 돌려줍니다.
   `divide()` 는 `RangeError` 를 던집니다.
2. **`Infinity` · `NaN` 문자열** — decimal.js 는 유효한 입력으로 받아들입니다.
   `toDecimal()` 은 거부합니다.

### 계산 컨텍스트 — 유효자릿수 60

decimal.js 의 **전역 기본 설정에 의존하지 않습니다.** 기본값은 유효자릿수 20 이고, 어떤 코드든
`Prisma.Decimal.set(...)` 을 부르면 프로세스 전체의 계산 결과가 바뀝니다. 되돌릴 수 없는 원장
데이터를 다루면서 그런 전역 상태에 기댈 수 없습니다.

`src/shared/decimal/context.ts` 가 **전용 생성자를 clone 해서 freeze** 합니다.

| 설정 | 값 | 기본값 |
|---|---|---|
| `precision` | **60** | 20 |
| `rounding` | `HALF_UP`(4) | 4 |
| `toExpNeg` | `-7` (기본값 명시 고정) | -7 |
| `toExpPos` | `21` (기본값 명시 고정) | 21 |
| `modulo` | `DOWN`(1) | 1 |

**precision 60 의 근거**

| 근거 | 유효자릿수 |
|---|---|
| 수량 `DECIMAL(18,6)` | 18 |
| 금액 `DECIMAL(18,4)` | 18 |
| 수량 × 금액 (정확한 곱) | **36** |
| 3항 연쇄 (수량 × 단가 × 환율·계수) | **54** |
| 나눗셈·평균의 중간 반올림 여유 | +6 |
| **합계** | **60** |

요구 하한 40 을 넘고, 3항 연쇄까지 절단 없이 담깁니다. decimal.js 상한은 `1e9` 이며 60 자리의
성능 비용은 무시할 수준입니다.

**clone + freeze 를 택한 이유**

- **clone** — `Prisma.Decimal` 의 설정이 외부 코드에 의해 바뀌어도 이쪽 계산은 영향받지 않습니다.
- **freeze** — 이쪽 설정도 `set()` 이나 직접 대입으로 바꿀 수 없습니다.
- decimal.js 의 clone 은 **프로토타입을 공유하고 `constructor` 만 인스턴스마다** 따로 갖습니다.
  따라서 `instanceof Prisma.Decimal` 과 `Prisma.Decimal.isDecimal()` 이 그대로 성립하고,
  Prisma 에 값을 넘기거나 Prisma 가 돌려준 Decimal 을 받는 데 문제가 없습니다.

> ⚠️ 연산은 **수신자의 생성자 설정**을 따릅니다. Prisma 가 돌려준 Decimal 을 그대로 받아
> `.plus()` 를 부르면 유효자릿수 20 으로 계산됩니다. 그래서 `toDecimal()` 이 외부 컨텍스트의
> Decimal 을 **항상 전용 생성자로 다시 감쌉니다.**

> ⚠️ freeze 때문에 `ln()` · `exp()` 는 쓸 수 없습니다. decimal.js 가 이 함수들에서
> `Decimal.precision` 을 일시적으로 올려 쓰기 때문입니다. 수량·금액 계산에는 필요 없고,
> 이 모듈도 노출하지 않습니다.

**생성자를 barrel 로 내보내지 않습니다.** `@/shared/decimal` 에서 얻을 수 있는 것은 함수와
타입뿐입니다. 값 생성은 `toDecimal()` 을 거치므로 컨텍스트를 우회한 Decimal 이 만들어지지 않습니다.

**지수표기 임계값은 기본값으로 둡니다.** 임계값을 극단(`-9e15` / `9e15`)으로 밀어 "지수표기가 절대
안 나오게" 만들 수도 있지만, 그러면 `new Decimal('1e1000000000').toString()` 이 **10억 자리 문자열을
만들려다 메모리를 소진합니다.** 거대한 지수 입력이 방어 없이 펼쳐지는 셈입니다.

따라서 `toString()` 은 범위 밖에서 지수표기를 씁니다. **지수표기 없는 업무 출력은
`toDecimalString()` 만 보장합니다.**

### 직렬화 안전 한도

`toDecimalString()` 은 문자열을 **만들기 전에** 값의 규모를 검사하고, 한도를 넘으면 거대한 문자열을
만드는 대신 `RangeError` 를 던집니다.

| 한도 | 값 | 근거 |
|---|---|---|
| 최대 유효자릿수 | 60 | `DECIMAL_PRECISION` 과 동일 |
| 최대 정수부 자릿수 | 60 | 3항 연쇄 결과(≈36)의 여유 포함 |
| 최대 소수부 자릿수 | 60 | 나눗셈 중간 결과(최대 60자리) 수용 |
| 최대 문자열 길이 | 128 | 부호 1 + 정수 60 + `.` + 소수 60 = 122 |

decimal.js 는 값을 (유효숫자 배열, 지수)로 들고 있어 `1e1000000000` 도 **생성 자체는 쌉니다.**
비싼 것은 `toFixed()` 로 펼치는 순간이므로, 그 직전에 규모를 봅니다.

```ts
toDecimalString(toDecimal('999999999999.999999'));  // '999999999999.999999'  (DECIMAL(18,6) 최대치)
toDecimalString(divide('1', '3'));                  // 소수부 60자리, 일반표기
toDecimalString(toDecimal('1e1000000000'));         // ❌ RangeError (즉시)
toDecimalString(toDecimal('1e-1000000000'));        // ❌ RangeError (즉시)
```

소수부가 한도를 넘는 값은 `scale` 을 지정해 반올림하면 직렬화됩니다.
오류 메시지에는 값 자체를 넣지 않습니다 — 그것을 펼치는 순간이 바로 막으려던 비용입니다.

### 두 층위의 반올림 — 혼동하지 마세요

| | 중간 연산 | 업무 정책 |
|---|---|---|
| 무엇 | 유효자릿수를 넘는 중간 결과(나눗셈 등) | DB 저장·화면 표시 시 확정하는 자릿수 |
| 어디 | `context.ts` 의 `DECIMAL_PRECISION` / `DECIMAL_ROUNDING` | `roundToScale(value, scale, rounding)` |
| 값 | 60 자리 / `HALF_UP` (고정) | 필드마다 다름 (**미확정**) |
| 누가 정하나 | 시스템 (전역 고정) | 호출부가 매번 명시 |

`roundToScale` 의 `rounding` 에는 **기본값이 없습니다.** 필드별 반올림 정책(수량 6자리 사사오입,
금액 4자리 은행가 반올림 등)은 아직 확정되지 않은 업무 규칙이며, 유틸이 조용히 하나를 골라서는
안 됩니다.

```ts
roundToScale(value, 6, ROUNDING.HALF_UP);
roundToScale(value, 4, ROUNDING.HALF_EVEN);
roundToScale(value, 6);                      // ❌ 컴파일 오류
```

### 허용되는 문자열 직렬화

**`toDecimalString()` 을 쓰세요.** `Decimal.toString()` 은 지수가 크거나 작으면 **지수표기**로
나옵니다.

```ts
new Decimal('1e25').toString()        // '1e+25'    ← 엑셀·외부 시스템이 오해합니다
toDecimalString(toDecimal('1e25'))    // '10000000000000000000000000'

new Decimal('1e-7').toString()        // '1e-7'
toDecimalString(toDecimal('1e-7'))    // '0.0000001'
```

AS-IS 엑셀에서 바코드가 지수표기로 깨진 것과 같은 종류의 사고입니다.
`toDecimalString()` 은 규모를 검사한 뒤 `toFixed()` 로 펼치므로, 성공하면 항상 일반 표기입니다.
한도를 넘는 값은 문자열을 만들지 않고 `RangeError` 를 던집니다(위 「직렬화 안전 한도」 참조).

자릿수를 고정하려면 `toDecimalString(value, 6)` 처럼 scale 을 넘깁니다.

### ESLint 규칙 — `deeppoint/no-decimal-to-number`

Decimal 을 `number` 로 바꾸는 코드는 **lint 오류**입니다.

```ts
// ❌ 금지
decimal.toNumber();
Number(decimal);
+decimal;
parseFloat(decimal.toString());
parseInt(decimal.toString(), 10);
Number(decimal.toFixed(6));          // 문자열로 우회해도 막힙니다

// ✅ 허용 — 일반 문자열·number
Number('123');
parseFloat('1.25');
parseInt('10', 10);

// ✅ 허용 — Decimal 을 Decimal 로 다루거나 문자열로 직렬화
add(a, b);
decimal.toFixed(6);
toDecimalString(decimal);
```

**변수 이름이 아니라 타입으로 판정합니다.** `decimal` 이라는 이름을 확인하는 방식은 변수명을
바꾸면 우회됩니다. 이 규칙은 TypeScript 타입 검사기로 표현식의 타입이 Decimal 인지 봅니다.
따라서 직접 생성값, 함수 인자, 객체 속성, 연산 결과, 별칭 import(`import { Decimal as D }`),
상속 타입, 이름을 바꾼 변수가 모두 걸립니다.

타입 정보가 필요하므로 `eslint.config.ts` 의 해당 블록에서 `parserOptions.projectService` 를
켭니다. 적용 범위는 `src/**` 입니다.

규칙 자체의 테스트는 [`tests/eslint-rules/no-decimal-to-number.test.ts`](tests/eslint-rules/no-decimal-to-number.test.ts)
에 있습니다. 위반 예제 파일(`eslint-rules/__fixtures__/`)은 전체 lint 를 상시 실패시키지 않도록
`globalIgnores` 에서 제외하고, 테스트가 ESLint API 로 직접 검사합니다.

---

## 인증과 권한

Supabase Auth 로 인증하고, 권한은 **로컬 DB** 를 기준으로 판정합니다.

### 모델

| 테이블 | 내용 |
|---|---|
| `user` | SCM 사용자. `id` 는 Supabase `auth.users.id` 와 같은 UUID |
| `role` | `ADMIN` / `SCM_LEADER` / `SCM_STAFF` / `FINANCE` / `EXECUTIVE` |
| `permission` | `role.read` 같은 점 표기 권한 키 |
| `role_permission` | 역할 ↔ 권한 (복합 PK) |
| `user_role` | 사용자 ↔ 역할 (복합 PK, `grantedAt`·`grantedBy`) |

> ⚠️ Supabase 가 관리하는 `auth.users` 를 **모델링하거나 relation 으로 연결하지 않습니다.**
> 그 테이블은 Supabase 소유이고 스키마가 바뀔 수 있습니다. 로컬 `user` 는 인증 사용자의
> **미러**이자 SCM 권한 상태의 기준이며, `id` 만 공유합니다.

### 인증 성공 ≠ 사용 승인

| 상황 | 응답 |
|---|---|
| 세션 없음 · 토큰 무효 | `UNAUTHORIZED` **401** |
| 인증됐지만 로컬 `user` 행 없음 | `FORBIDDEN` **403** |
| 인증됐지만 `active = false` | `FORBIDDEN` **403** |
| 역할 없음 | `/api/me` 접근 가능, `permissions` 빈 배열 |
| 권한 없음 | `FORBIDDEN` **403** |

**인증 성공만으로 로컬 `user` 를 자동 생성하지 않습니다.** 그런 경로를 만들면 승인되지 않은
Supabase 계정이 SCM 시스템 사용자가 됩니다. 사용자 생성·초대·비밀번호 초기화 API 는 T0-6 범위
밖입니다.

### 쿠키의 세션 객체를 신뢰하지 않습니다

`auth.getSession()` 은 **쿠키에 담긴 세션 객체를 그대로** 돌려줍니다. 쿠키는 클라이언트가 보내는
값이라 위조될 수 있고 서버가 서명을 확인하지 않습니다. 그 안의 `user.id` 로 권한을 판정하면 누구든
아무 사용자로 행세할 수 있습니다.

| 용도 | 사용 |
|---|---|
| 인증 검증 | `auth.getClaims()` — JWT 서명 검증 |
| 최신 사용자 레코드가 꼭 필요할 때 | `auth.getUser()` — Supabase 왕복 |
| 권한 판정 | ❌ `auth.getSession()` 금지 |

소스 전체에 `getSession(` 이 없는지 테스트로 고정했습니다.

### Supabase 클라이언트

쿠키 접근 방식이 달라 셋으로 나눕니다 (`@supabase/ssr`).

| 파일 | 용도 |
|---|---|
| `src/shared/supabase/browser.ts` | 클라이언트 컴포넌트 |
| `src/shared/supabase/server.ts` | 서버 컴포넌트·Route Handler |
| `src/shared/supabase/proxy.ts` | Proxy 의 세션 갱신 |

**환경변수는 두 개뿐입니다.** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
T0-6 은 Admin API 를 쓰지 않으므로 secret / service-role 키가 필요 없습니다.
`NEXT_PUBLIC_` 접두사가 붙은 값은 클라이언트 번들에 포함되므로 secret 키에는 절대 붙이지 마세요.

### ActorContext

```ts
type ActorContext = {
  userId: string;
  email: string;
  name: string;
  roles: readonly string[];        // 중복 제거·사전순 정렬
  permissions: readonly string[];  // 중복 제거·사전순 정렬
  requestId: string;
  sessionId?: string;
  ipAddress?: string;
};
```

**요청 본문이나 헤더에서 actor 정보를 받지 않습니다.** 검증된 Supabase 클레임과 DB 조회 결과로만
만듭니다. `resolveActor` 의 요청 인자는 `requestId` 와 `ipAddress` 뿐이라 위조 필드가 들어갈 자리가
없습니다. 비활성 사용자로는 `ActorContext` 자체를 만들 수 없습니다.

### 2겹 권한 가드

**1차 — `src/proxy.ts`**

> ⚠️ Next.js 16 에서 요청 가로채기는 `middleware.ts` 가 아니라 **`proxy.ts`** 이고 함수명도
> `proxy` 입니다. `middleware.ts` 를 만들지 마세요.

- 공개 경로(`/api/health`, `/api/auth/login`, `/api/auth/logout`, `/login`, `/`)는 통과
- **표에 없는 경로는 기본이 보호** — 새 라우트를 깜빡해도 열리는 게 아니라 닫힙니다
- route policy 에 권한이 명시된 **경로·메서드 조합**은 그 권한까지 확인
- 실패 시 공통 형식의 JSON 401 / 403

**1차 가드는 HTTP 메서드까지 봅니다.** 경로만으로 판정하면 조회 권한만 가진 사용자의 `PATCH` 가
1차 가드를 통과해버립니다(2차 가드가 막긴 하지만 1차가 제 역할을 못 합니다).

```ts
import { resolveRoutePermission } from '@/modules/auth/application';

resolveRoutePermission({ pathname: '/api/system-settings', method: 'GET'   }); // 'system_setting.read'
resolveRoutePermission({ pathname: '/api/system-settings', method: 'PATCH' }); // 'system_setting.update'
resolveRoutePermission({ pathname: '/api/roles',           method: 'POST'  }); // undefined → 인증만
```

`ROUTE_PERMISSIONS` 는 앞에서부터 첫 번째로 맞는 정책을 쓰므로 **더 구체적인(메서드 지정) 정책을
앞에** 둡니다. `methods` 를 생략하면 모든 메서드에 적용됩니다.

| 경로 | 메서드 | 권한 |
|---|---|---|
| `/api/roles` | `GET` | `role.read` |
| `/api/system-settings` | `GET`, `HEAD` | `system_setting.read` |
| `/api/system-settings` | `PATCH`, `PUT`, `POST`, `DELETE` | `system_setting.update` |
| `/api/code-groups` | `GET`, `HEAD` | `common_code.read` |
| `/api/codes` | `GET`, `HEAD` | `common_code.read` |
| `/api/codes` | `POST`, `PATCH`, `PUT`, `DELETE` | `common_code.manage` |
| `/admin/codes` | `GET`, `HEAD` | `common_code.read` |

**2차 — Application Service**

```ts
export async function listRoles(actor: ActorContext, deps = {}) {
  assertPermission(actor, 'role.read');   // ★ Proxy 통과를 신뢰하지 않는다
  ...
}
```

Proxy 는 경로 기반이라 새 라우트에서 누락될 수 있고, 서버 액션·내부 호출·배치는 Proxy 를 거치지
않습니다. **Proxy 를 우회해 서비스를 직접 호출해도 403 이 납니다** — 테스트로 고정했습니다.

**ADMIN 예외가 없습니다.** ADMIN 도 `role_permission` 데이터로 권한을 취득합니다. 코드에 역할
이름을 넣는 순간 권한 표가 실제 접근 권한을 설명하지 못하게 되고, 감사에서 근거를 댈 수 없습니다.

### API

| 엔드포인트 | 권한 |
|---|---|
| `POST /api/auth/login` | 공개 |
| `POST /api/auth/logout` | 공개 (멱등) |
| `GET /api/me` | 인증 |
| `GET /api/roles` | `role.read` |
| `GET /api/system-settings` | `system_setting.read` |
| `PATCH /api/system-settings` | `system_setting.update` |
| `GET /api/code-groups` | `common_code.read` |
| `GET /api/codes/{groupCode}` | `common_code.read` |
| `POST /api/codes/{groupCode}` | `common_code.manage` |
| `PATCH /api/codes/{groupCode}/{code}` | `common_code.manage` |

```bash
pnpm db:seed        # 역할 5종 + role.read + ADMIN 부여 (재실행 안전)
```

시드는 T0-6 이 실제로 쓰는 최소 권한만 등록합니다. SKU·BOM·재고 권한을 미리 넣지 않습니다 —
쓰이지 않는 권한 행은 "누가 무엇을 할 수 있는가"를 흐리게 만듭니다.

---

## 감사로그와 시스템 설정

### 시스템 설정 (`system_setting`)

**타입이 명시된 단일 설정 행**입니다(singleton, `id = 1`). 자유 형식 JSON EAV 를 쓰지 않습니다 —
설정 하나하나가 업무 판정에 직접 쓰이므로 `valueType` 분기·NULL 조합·알 수 없는 키가 끼어들 여지를
두지 않습니다.

| 필드 | 타입 | 초기값 |
|---|---|---|
| `allowSelfApprovalSku` | boolean | `false` |
| `allowSelfApprovalBom` | boolean | `false` |
| `cutoverDate` | date \| null | `null` |
| `postingFrozen` | boolean | `false` |
| `version` | int | `1` |

> ⛔ 일반 `allow_self_approval` 컬럼은 만들지 않습니다.

```bash
GET /api/system-settings      # system_setting.read
PATCH /api/system-settings    # system_setting.update
```

```json
// GET 응답
{ "allowSelfApprovalSku": false, "allowSelfApprovalBom": false,
  "cutoverDate": null, "postingFrozen": false, "version": 1, "requestId": "..." }

// PATCH 요청 — version 필수
{ "postingFrozen": true, "version": 1 }
```

- 부분 수정 허용, 최소 한 필드 필요
- `version` 이 현재 값과 다르면 **409 `CONFLICT`**, 변경 시 `version` 증가
- 알 수 없는 필드·잘못된 타입 거부, `cutoverDate` 는 `YYYY-MM-DD` 또는 `null`
- `updatedBy` 는 요청 본문이 아니라 **`ActorContext`** 에서 가져옵니다
- **변경 없는 동일 값 요청도 정상 처리**합니다. 값은 그대로지만 `version` 은 증가하고 감사로그도
  남습니다 — "누가 언제 이 값을 확정했는가"가 기록으로 필요하고, 조용히 무시하면 `version` 이
  어긋난 클라이언트가 성공했다고 오해합니다.

설정 변경과 감사로그 INSERT 는 **같은 트랜잭션**에서 처리합니다.

#### 낙관적 동시성 — `version` 은 `WHERE` 절에서 판정합니다

읽어서 비교한 뒤 UPDATE 하면 **막지 못합니다.** `READ COMMITTED` 에서 두 요청이 같은 `version` 을
읽고 **둘 다** 통과합니다. 그래서 `version` 을 **UPDATE 문의 `WHERE` 절**에 넣어 DB 가 원자적으로
판정하게 합니다.

```ts
const updated = await tx.systemSetting.updateMany({
  where: { id: SYSTEM_SETTING_ID, version: expectedVersion },  // ★ 동시성 토큰
  data: { ...patch, updatedBy: actor.userId, version: { increment: 1 } },
});                                                            // ★ 증가도 UPDATE 안에서

if (updated.count !== 1) {
  const current = await tx.systemSetting.findUniqueOrThrow({ where: { id: SYSTEM_SETTING_ID } });
  throw versionConflict(expectedVersion, current.version);     // 409
}
```

- `version: { increment: 1 }` — 읽고·더하고·쓰는 틈이 없습니다. `before.version + 1` 을 계산해서
  넣으면 그 틈에서 다시 덮어쓰기가 발생합니다.
- `updateMany` 앞의 read-then-compare 는 **빠른 실패용**일 뿐 동시성 판정이 아닙니다.
  실제 판정은 위 `WHERE` 절이 합니다.
- ⛔ **자동 재시도하지 않습니다.** 충돌 응답은 `retryable: false` 이고 `publicDetails.currentVersion`
  으로 충돌 시점의 최신 `version` 을 알려줍니다. 무엇이 바뀌었는지 모르는 채로 다시 보내면
  남의 변경을 덮어씁니다. 클라이언트가 다시 조회하고 사람이 판단해야 합니다.

`src/modules/settings/system-settings-db.test.ts` 가 **실제 PostgreSQL** 에서 barrier 로 두 요청을
같은 `version` 으로 동시에 출발시켜 검증합니다. 대역(fake)으로는 이 상황을 재현할 수 없습니다.

#### DB 제약

```sql
CHECK ("id" = 1)         -- system_setting: 싱글턴. 두 번째 행 자체가 불가능
CHECK ("version" >= 1)   -- system_setting
```

싱글턴은 애플리케이션 관례가 아니라 **DB 제약**입니다. 관례는 언젠가 깨지고, 설정 행이 둘이 되면
어느 쪽이 진짜인지 판정할 방법이 없습니다.

### 자기승인 정책

| 워크플로 | 자기승인 |
|---|---|
| `SKU` | `allow_self_approval_sku` 설정 |
| `BOM` | `allow_self_approval_bom` 설정 |
| `INVENTORY_ADJUSTMENT` | ❌ **항상 금지** |
| `NEGATIVE_STOCK_EXCEPTION` | ❌ **항상 금지** |
| `INVENTORY_CLOSE_REOPEN` | ❌ **항상 금지** |

아래 3종은 **설정을 읽지 않습니다.** 설정으로 열 수 있게 두면 언젠가 열립니다. 재고 원장은
불변이고 마감은 회계 기간을 확정하므로, 한 사람이 요청과 승인을 모두 하면 통제가 성립하지
않습니다. **ADMIN 도 예외가 없습니다** — `assertApprovalActor` 는 역할을 인자로 받지 않습니다.

```ts
import { assertApprovalActor, canSelfApprove } from '@/modules/settings/application';

assertApprovalActor({ requesterId, approverId, workflow: 'SKU', settings });
// 금지 시 SELF_APPROVAL_FORBIDDEN / HTTP 403
```

T0-7 은 실제 SKU·BOM·재고조정 워크플로를 구현하지 않습니다. 정책 함수만 확정해 두어 나중에 각
모듈이 제각기 다른 규칙을 만들지 않게 합니다.

### 감사로그 (`audit_log`) — 불변

```ts
await withTransaction(async (tx) => {
  const before = await tx.systemSetting.findUniqueOrThrow({ where: { id: 1 } });
  const after = await tx.systemSetting.update({ where: { id: 1 }, data });

  await auditLogger.write(tx, {       // ★ 첫 인자가 트랜잭션 클라이언트
    actor, entityType: 'SystemSetting', entityId: '1',
    action: 'UPDATE', beforeValue: before, afterValue: after,
  });

  return after;
});
```

**트랜잭션 클라이언트를 반드시 주입받습니다.** 첫 인자가 `TransactionClient` 이므로 트랜잭션
밖에서는 **타입상 호출할 수 없습니다.** 업무 변경과 감사로그가 다른 트랜잭션에 있으면 "기록 없는
변경" 또는 "일어나지 않은 일의 기록" 중 하나가 남고, 둘 다 감사 기록을 근거로 쓸 수 없게 만듭니다.

`actorId` · `requestId` · `sessionId` · `ipAddress` 는 **`ActorContext` 에서만** 가져옵니다.
`occurredAt` 도 호출부가 지정할 수 없습니다(DB 기본값). 수행자와 시각을 호출부가 정할 수 있으면
감사로그가 아니라 그냥 메모입니다.

#### `entity_id` 는 UUID 가 아니라 TEXT 입니다

감사로그는 **모든 엔티티의 변경을 한 테이블에 모으므로**, 서로 다른 타입의 PK 를 하나의 컬럼으로
정규화해야 합니다. ERD 전반의 PK 는 UUID 지만 `audit_log.entity_id` 만은 TEXT 입니다.

| 항목 | 규칙 |
|---|---|
| `audit_log.id` | 감사로그 **자기 행의 PK**. UUID. 대상 엔티티와 무관합니다. |
| `audit_log.entity_id` | **대상 엔티티의 PK 를 문자열로 정규화**한 값. TEXT. |
| UUID PK 엔티티 (`sku`, `bom`, `purchase_order` …) | UUID 를 그대로 문자열로 저장 |
| 정수 PK 엔티티 (`system_setting`) | 정수를 문자열로 변환 — **항상 `"1"`** (싱글턴) |
| 복합키 엔티티 (`user_role` 등) | 구성 키를 `:` 로 이은 문자열 |

```sql
CHECK (length(trim("entity_id")) > 0)     -- audit_log
CHECK (length(trim("entity_type")) > 0)   -- audit_log
```

- ⛔ **빈 문자열·공백 금지.** DB `CHECK` 로 막습니다. 대상을 알 수 없는 감사로그는 기록이 없는
  것만 못합니다.
- ⛔ **화면용 문서번호를 넣지 않습니다.** `PO-2026-0012` 같은 표시용 번호는 정정·재발번으로 바뀔 수
  있어 추적이 끊깁니다. **실제 PK** 를 넣고, 표시용 번호는 `beforeValue`/`afterValue` 안에 담습니다.
- `entity_type` + `entity_id` 로 조회하므로 같은 엔티티에는 **항상 같은 정규화 규칙**을 씁니다.
  한 곳만 형식이 달라지면 그 이력이 조회에서 누락됩니다.

저장 전 정규화: `Decimal` → 문자열, `Date` → ISO 문자열, `BigInt` → 문자열, `undefined` 키 제거,
순환 참조 거부, `password`·`token`·`cookie`·`authorization` 등 민감값 마스킹. 감사로그는 불변이라
잘못 들어간 값을 지울 수 없기 때문입니다.

**전체 Prisma mutation 을 자동 감시하는 middleware·extension 을 쓰지 않습니다.** 각 Application
Service 가 명시적으로 호출합니다. 자동 감시는 무엇이 기록되는지 코드에서 보이지 않고, 업무
의미(action·reason·승인자)를 담지 못합니다.

### 불변성은 DB 가 보장합니다

```sql
CREATE TRIGGER audit_log_no_update    BEFORE UPDATE   ON audit_log FOR EACH ROW ...
CREATE TRIGGER audit_log_no_delete    BEFORE DELETE   ON audit_log FOR EACH ROW ...
CREATE TRIGGER audit_log_no_truncate  BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT ...
```

세 트리거 모두 `AUDIT_LOG_IMMUTABLE` 예외를 던집니다. 애플리케이션 코드만으로 불변성을 보장하지
않습니다 — psql·관리도구·잘못된 배치에서 직접 실행하는 SQL 도 막아야 감사 기록이 근거가 됩니다.

`audit_log.actor_id` / `approved_by` 는 `ON DELETE RESTRICT` 라 **감사로그가 있는 사용자는 삭제되지
않습니다.** `updated_at` 컬럼이 없고 수정·삭제 API 도 없습니다.

> ⚠️ **PostgreSQL 한계**: 테이블 소유자와 superuser 는 `ALTER TABLE audit_log DISABLE TRIGGER ALL`
> 로 트리거를 끌 수 있습니다. DB 수준에서 이를 막을 방법은 없습니다. 운영에서는 애플리케이션
> 롤에 테이블 소유권을 주지 않고, 소유자 계정 사용을 별도 통제·감사 대상으로 둡니다.

---

## 공통코드 (T0-8)

5개 엑셀에 흩어져 있던 코드사전의 단일 기준입니다.
`common_code_group`(그룹) / `common_code`(코드 값), 물리 컬럼은 전부 snake_case 입니다.

### 시드 — 원본 그대로, 수량은 실측

`prisma/seed/common-code-data.ts` 는 **원본 엑셀에서 기계 추출한 값**입니다. 오탈자(대분류 SL 의
영문명 `Styiling`)도 고치지 않습니다 — 코드사전의 기준은 원본이고, 보정은 원본 소유자의 확인을
거쳐 별도 변경으로 처리합니다.

| 그룹 | groupCode | 시드 수량 |
|---|---|---|
| 브랜드 | `BRAND` | 2 |
| 대분류 | `MAJOR_CATEGORY` | **12** — 설계 문서의 "13"은 집계 오기. 원본 사전에 12행 |
| 소분류 | `MINOR_CATEGORY` | 19 |
| 부자재분류 | `MATERIAL_CATEGORY` | **38** — 원본 39행 중 `ET`(기타) 중복 1건 제외 |
| 보관처 | `STORAGE_LOCATION` | 11 — `BOC`·`BON` 명칭 동일(중복 의심값, 원본대로 시드) |
| 채널 | `CHANNEL` | 16 |
| **합계** | | **98** |

**원본 행과 고유 코드를 구분합니다** — 원본 코드사전 **99행** / natural key(`group`, `code`) 기준
고유 **98코드** / 실제 seed **98코드**. `ET`(기타)가 부자재분류 원본 순번 24와 30에 2회 등장하므로
`UNIQUE(group_id, code)` 에 따라 `common_code` 에는 **정확히 1건**만 들어가고, 수를 맞추기 위한
`ET2` 같은 임의 코드는 만들지 않습니다. 종전 "100건"은 ① 대분류 12를 13으로 오기, ② `ET` 2행을
각각 집계 — 두 오류의 합입니다 (문서 정오: `docs/01_AS-IS_엑셀분석.md` §1.6).

시드는 idempotent 합니다 — natural key(`groupCode`, `(groupId, code)`)로 upsert 하므로 재실행해도
중복이 없고 **UUID 가 바뀌지 않으며**, 사용자가 API 로 추가한 커스텀 코드를 건드리지 않습니다.
전체가 **한 트랜잭션**이라 부모 코드 누락 등으로 실패하면 부분 시드 없이 롤백됩니다.

원본 사전에는 그룹 간 계층이 없습니다(소분류 8종이 여러 대분류 아래에서 사용됨을 SKU 데이터로
확인). 6개 그룹 모두 `parent_group_id = NULL` 이고, 계층 검증 로직은 테스트 픽스처로 검증합니다.

### ⛔ 물리삭제가 없습니다 — "삭제" = 비활성화

| 상황 | 처리 |
|---|---|
| 미사용 코드 | `active=false` (물리삭제 아님) |
| 사용 중 코드 | 역시 `active=false` 만 허용 |
| 코드 이력 | 행을 보존 |

- DELETE API 가 없고, Application 계층에 delete 메서드가 없습니다 (테스트로 고정)
- 화면·API 용어도 "삭제"가 아니라 **"비활성화"** 입니다
- 비활성 코드도 감사·이력 목적으로 DB 에 남습니다
- `code` 와 `group` 은 생성 후 변경 불가 — 이름·정렬순서·속성·활성 여부만 수정합니다

> ⚠️ **향후 참조 규칙**: SKU·Warehouse·BOM 등에서 `common_code` 를 참조할 때는 반드시
> **FK `ON DELETE RESTRICT`** 를 씁니다. 참조되는 코드가 지워지는 경로 자체를 DB 가 막아야
> 합니다. (T0-8 에는 해당 모델이 없으므로 이 규칙만 남깁니다)

### DB 제약

```sql
UNIQUE (group_code)                         -- common_code_group
UNIQUE (group_id, code)                     -- common_code (그룹 내 유일, 다른 그룹은 동일 code 허용)
CHECK  (code = btrim(code) AND length > 0)  -- code·name·group_code 빈 값·앞뒤 공백 금지
CHECK  (sort_order >= 0)
CHECK  (parent_code_id <> id)               -- 자기참조 금지 (그룹도 동일)
FK ON DELETE RESTRICT                       -- group_id, parent_code_id, parent_group_id
```

부모 코드 정합성(그룹의 상위 그룹 코드만 부모 허용 · 순환 금지 · 비활성 부모에 활성 자식 연결
금지)은 Application Service 가 검증합니다 — 서로 다른 그룹 간 참조라 단순 DB 제약으로는 표현되지
않습니다.

### 권한

| 역할 | `common_code.read` | `common_code.manage` |
|---|---|---|
| ADMIN | ✅ | ✅ |
| SCM_LEADER / SCM_STAFF / FINANCE / EXECUTIVE | ✅ | — |

ADMIN 도 `role_permission` 행으로만 권한을 얻습니다 — 코드상 특별 통과가 없습니다.

### API

```bash
GET   /api/code-groups                 # common_code.read — 그룹 목록 + 수량
GET   /api/codes/{groupCode}?active=true|false|all   # common_code.read (기본 active=true)
POST  /api/codes/{groupCode}           # common_code.manage — 코드 추가 (201)
PATCH /api/codes/{groupCode}/{code}    # common_code.manage — name·parentCode·sortOrder·attributes·active
```

- 정렬은 `sort_order ASC, code ASC`, 없는 그룹은 404
- 그룹 생성·수정 API 는 없습니다 — 그룹은 seed·migration 관리 대상
- **동일 값 PATCH 는 400** — "변경할 내용이 없습니다." (`VALIDATION_ERROR`)
- 하위 활성 코드가 있는 부모 비활성화, 비활성 부모 아래 자식 재활성화는 **409 `CONFLICT`**
- 코드 POST·PATCH 는 T0-7 AuditLogger 로 `CREATE / UPDATE / DEACTIVATE / REACTIVATE` 를
  **같은 트랜잭션**에서 기록합니다. `entity_id` 는 실제 CommonCode UUID 입니다.

### 관리 화면 — `/admin/codes`

그룹 선택(그룹별 전체·활성·비활성 수량) · active 필터 · 코드/명칭 검색 · 신규 추가 · 수정 ·
비활성화(확인 후)/재활성화. 코드 값이 생성 후 불변임을 화면에 명시하고, 삭제 버튼은 없습니다.
`common_code.manage` 가 없으면 수정 UI 를 렌더링하지 않지만 — **권한의 근거는 항상 서버**입니다
(1차 Proxy + 2차 Application Service).

### E2E

```bash
pnpm test:e2e        # Playwright — 스텁 Supabase(54321) + next dev(3100) 자동 기동
```

`tests/e2e/supabase-stub.ts` 는 Supabase Auth 의 환경 대역입니다. 앱은 운영과 같은 인증 경로
(@supabase/ssr → 쿠키 → `getClaims`)를 그대로 타며, **앱 코드·production bundle 에 테스트 분기가
없습니다** — 스텁은 `NEXT_PUBLIC_SUPABASE_URL` 환경변수로만 연결됩니다.

---

## 오류 처리

모든 API 오류는 `src/shared/errors` 의 공통 체계를 통해 응답합니다.
Route Handler 에서 오류 객체를 직접 직렬화하지 않습니다.

```ts
import { withErrorHandling, DomainError, ERROR_CODES } from '@/shared/errors';

export async function POST(request: Request) {
  return withErrorHandling(request, async () => {
    throw new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      message: '창고 OLPUN 가용 10, 요청 12',        // 개발 debug · 서버 로그
      publicDetails: { available: '10.000000' },     // ✅ 외부 응답에 포함
      publicHint: '동일 재고키 2개 항목이 합산되었습니다.', // ✅ 외부 응답에 포함
      details: { internalSkuId, ledgerEntryId },     // ★ 서버 로그 전용
      context: { skuId, warehouseId },               // ★ 서버 로그 전용
    });
  }, { route: '/api/skus' });
}
```

### 부가정보 4종의 노출 범위

| 필드 | 외부 응답 | 서버 로그 |
|---|:-:|:-:|
| `context` | ❌ | ✅ |
| `details` | ❌ | ✅ |
| `publicDetails` | ✅ (`expected` 한정) | ✅ |
| `publicHint` | ✅ (`expected` 한정) | ✅ |
| `fieldErrors` | ✅ | — |

**기본값은 비공개입니다.** 예상 가능한 오류라는 사실만으로 부가정보가 공개해도 되는 값임이
보장되지는 않습니다. 재고 부족 하나만 봐도 "가용수량"은 공개해도 되지만 "내부 SKU UUID"는
아닙니다. 공개하려면 호출부가 `publicDetails` / `publicHint` 로 **명시**해야 합니다.

예상하지 못한 오류(`expected = false`)는 `publicDetails` 를 넘겨도 응답에 실리지 않습니다.

### 오류 클래스

| 클래스 | HTTP | 성격 | `expected` |
|---|---|---|:-:|
| `ValidationError` | 400 | 요청 형식·스키마 위반 | ✅ |
| `AuthorizationError` | 401 / 403 | 인증·권한 | ✅ |
| `ConflictError` | 409 | 동시성·상태 충돌 (재시도 가능) | ✅ |
| `DomainError` | 422 | 업무규칙 위반 | ✅ |
| `EnvironmentError` | 500 | 환경변수·서버 설정 오류 | ❌ |
| `SystemError` | 500 | 예상하지 못한 오류 | ❌ |

### 응답 포맷

```json
{
  "errorCode": "INSUFFICIENT_STOCK",
  "message": "재고가 부족합니다.",
  "requestId": "e645e91c-175b-4815-a8d5-911506643b78",
  "publicDetails": { "available": "10.000000", "requestedNet": "12.000000" },
  "publicHint": "동일 재고키의 2개 항목이 합산되어 검증되었습니다."
}
```

### `requestId` 와 `correlationId`

| | 출처 | 응답 본문 | `x-request-id` 헤더 | 서버 로그 |
|---|---|:-:|:-:|:-:|
| `requestId` | **서버가 항상 `randomUUID()` 로 생성** | ✅ | ✅ | ✅ |
| `correlationId` | 요청의 `x-request-id` 또는 `x-vercel-id` | ❌ | ❌ | ✅ |

외부에서 받은 값을 시스템 식별자로 쓰지 않습니다.

1. **유일성을 보장할 수 없습니다.** 같은 값을 반복 전송하면 서로 다른 요청이 같은 ID를 갖게 되어
   로그 추적이 무너집니다.
2. **공격자가 통제할 수 있습니다.** 다른 사용자의 ID를 사칭하거나 로그 검색을 오염시킬 수 있습니다.

그래도 버리지는 않습니다. 게이트웨이·프론트엔드의 추적 ID 와 서버 로그를 잇는 데 필요하므로
`correlationId` 로 **로그에만** 남깁니다. 제어문자는 제거되고 200자로 잘립니다.
외부 헤더가 없으면 `correlationId` 는 생략됩니다.

### 내부 로그 ↔ 외부 응답 분리

| 항목 | 운영 응답 | 개발 응답 | 서버 로그 |
|---|:-:|:-:|:-:|
| `message` | 코드별 고정 문구 | 상세 메시지 (`expected` 한정) | 상세 메시지 |
| `publicDetails` · `publicHint` | ✅ | ✅ | ✅ |
| `details` | ❌ | ❌ | ✅ |
| `context` | ❌ | ❌ | ✅ |
| `stack` | ❌ | `debug.stack` | 예상 못한 오류만 |
| `requestId` | ✅ | ✅ | ✅ |
| `correlationId` | ❌ | ❌ | ✅ |

**핵심 원칙**

1. **운영 응답에 DB URL·호스트·포트·환경변수명·스택을 절대 노출하지 않습니다.**
2. `details` 와 `context` 는 어떤 환경에서도 응답에 나가지 않습니다 (서버 로그 전용).
3. **예상하지 못한 오류**(`SystemError`, `EnvironmentError`, 정규화된 일반 `Error`)는
   환경과 무관하게 **고정 문구 + HTTP 500** 입니다. 내부 메시지에 연결 문자열이 섞일 수 있기 때문입니다.
4. 예상 가능한 오류는 `warn`, 예상하지 못한 오류는 `error` 레벨로 기록됩니다.
5. 응답의 `requestId` 로 서버 로그를 찾을 수 있습니다.
6. 로그 검색의 **1차 판별 키는 `errorCode`** 입니다. `errorName` 은 보조 정보입니다.

### 오류 타입명은 빌드에 의존하지 않습니다

`AppError` 는 `new.target.name` / `this.constructor.name` 을 쓰지 않습니다. 운영 빌드의
최소화(minify) 과정에서 클래스명이 지워지면 로그의 `errorName` 이 빈 문자열이 됩니다
(실제로 발생했습니다). 각 하위 클래스가 `ERROR_TYPE` 의 고정 문자열을 넘깁니다.

```
AppError · DomainError · AuthorizationError · ConflictError
ValidationError · SystemError · EnvironmentError
```

이 값들은 개발·테스트·운영 빌드에서 동일합니다. `error.name` 과 `error.errorType` 이 같은 값이며,
`AppError` 가 아닌 값도 `toAppError` 가 `SystemError` 로 정규화하므로 `errorName` 은 항상 채워집니다.

### 서버 로그의 자격증명 마스킹

로그는 신뢰 경계 안에 있지만 수집기·백업·화면 캡처로 새어 나갑니다. 두 축으로 가립니다
(`src/shared/errors/redact.ts`).

**① 키 기반** — 객체·배열·`Error.cause` 를 재귀 순회하며 민감한 이름의 값을 `***` 로 치환합니다.
키는 소문자화 + 영숫자만 남겨 비교하므로 `set-cookie`, `DATABASE_URL`, `accessToken` 이 모두 걸립니다.

```
password · passwd · secret · token · authorization · cookie
apiKey · DATABASE_URL · DIRECT_URL · connectionString
```

**② 패턴 기반** — 문자열에 섞여 들어온 자격증명을 형태로 탐지합니다.

| 입력 | 출력 |
|---|---|
| `postgresql://scm:pw@db.internal:5432/prod` | `postgresql://***:***@db.internal:5432/prod` |
| `Bearer eyJhbGciOiJIUzI1NiJ9.…` | `Bearer ***` |
| `Basic YWRtaW46c3VwZXJzZWNyZXQ=` | `Basic ***` |

호스트·포트·데이터베이스명은 남깁니다. 디버깅에 필요하고, 외부 응답으로 나가지 않는 것은
`buildErrorResponse` 가 보장합니다.

### 오류 응답 확인 (개발 전용)

```bash
# .env.local 에 ENABLE_ERROR_PREVIEW="true" 추가 후
pnpm dev
curl -s "http://localhost:3000/api/dev/error-preview?kind=domain" | jq
# kind: validation | authorization | conflict | domain | system | unknown
```

> 이 라우트는 **`NODE_ENV !== 'production'` 이면서 `ENABLE_ERROR_PREVIEW="true"` 일 때만**
> 동작합니다. 기본값은 비활성화이며, 두 조건 중 하나라도 어긋나면 **JSON 404** 를 반환합니다.
> 환경 판정 하나에만 의존하지 않는 이유: 스테이징·프리뷰 배포처럼 `NODE_ENV` 가 production 이
> 아니면서 외부에 노출되는 환경이 있습니다.

---

## 배포

| 환경 | DB | 배포 |
|---|---|---|
| 개발 | 로컬 PostgreSQL / Supabase CLI | 로컬 |
| 스테이징 | Supabase Staging | PR 머지 시 자동 (Vercel Preview) |
| 운영 | Supabase Production | `main` 머지 + **수동 승인 게이트** |

> 배포 파이프라인은 T0-9에서 구성합니다.

---

## 설계 문서

| 문서 | 내용 |
|---|---|
| [`docs/README.md`](docs/README.md) | 설계 산출물 색인 |
| [`docs/00_요구사항_이해와_충돌검토_v0.2.md`](docs/00_요구사항_이해와_충돌검토_v0.2.md) | 요구사항·충돌검토·확정사항 |
| [`docs/01_AS-IS_엑셀분석.md`](docs/01_AS-IS_엑셀분석.md) | 기존 엑셀 분석 |
| [`docs/02_시스템_아키텍처와_모듈구조.md`](docs/02_시스템_아키텍처와_모듈구조.md) | 아키텍처·모듈 구조 |
| [`docs/03_ERD와_Prisma스키마_v0.2.md`](docs/03_ERD와_Prisma스키마_v0.2.md) | ERD·Prisma 스키마 |
| [`docs/04_재고_PostingService와_현재고전략_v0.2.md`](docs/04_재고_PostingService와_현재고전략_v0.2.md) | 재고 Posting Service |
| [`docs/05_API와_화면설계_v0.2.md`](docs/05_API와_화면설계_v0.2.md) | API·화면 |
| [`docs/06_데이터_마이그레이션설계_v0.2.md`](docs/06_데이터_마이그레이션설계_v0.2.md) | 마이그레이션 |
| [`docs/07_개발백로그와_테스트전략_v0.2.md`](docs/07_개발백로그와_테스트전략_v0.2.md) | 백로그·테스트 |
| [`docs/PENDING_v0.3_보완사항.md`](docs/PENDING_v0.3_보완사항.md) | **R1a-2 착수 전 반영 필요 7건** |
