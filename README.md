# DEEPPOINT SCM OS

구매·발주, 공급계획, 재고, WMS 실행, S&OP를 통합한 내부 SCM 운영 시스템.

> **현재 단계: `R1a-0 / T0-3` — 공통 오류체계**
> 인증과 업무 모듈은 아직 구현되지 않았습니다. 업무 모델(테이블)도 아직 없습니다.
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
| 테스트 | Vitest 3 | T0-1 ✅ (Testcontainers는 T0-9) |
| 데이터베이스 | PostgreSQL 16 + Prisma 7 (`@prisma/adapter-pg`) | T0-2 ✅ |
| 인증 | Supabase Auth | T0-6 |
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
| `pnpm test` | Vitest 1회 실행 |
| `pnpm test:watch` | Vitest watch |
| **`pnpm verify`** | **typecheck → lint → format:check → test → build 전체 검증** |

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

> `typecheck` 가 `next typegen` 을 선행하는 이유: Next.js 16은 `LayoutProps` / `PageProps` 등
> 라우트 타입을 `.next/types` 에 생성합니다. `tsc` 단독 실행 시 이 타입을 찾지 못합니다.

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
│     ├─ db/                    Prisma 클라이언트 · 연결 점검
│     └─ errors/                공통 오류체계 · request ID · 로깅
├─ docker-compose.yml           로컬 PostgreSQL
├─ prisma.config.ts             Prisma CLI 설정 (DIRECT_URL)
├─ components.json              shadcn/ui 설정
├─ eslint.config.mjs
├─ vitest.config.ts
└─ .env.example
```

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
| `NEXT_PUBLIC_SUPABASE_URL` 외 | | 인증 | T0-6 |
| `SUPABASE_STORAGE_BUCKET_*` | | 파일 저장 | T4-2 |
| `PGBOSS_DATABASE_URL` | | 잡 큐 | T4-1 |

`.env.example` 에는 **형식과 설명만** 있으며 운영 자격증명은 포함되지 않습니다.

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

## 오류 처리

모든 API 오류는 `src/shared/errors` 의 공통 체계를 통해 응답합니다.
Route Handler 에서 오류 객체를 직접 직렬화하지 않습니다.

```ts
import { withErrorHandling, DomainError, ERROR_CODES } from '@/shared/errors';

export async function POST(request: Request) {
  return withErrorHandling(request, async () => {
    throw new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      message: '창고 OLPUN 가용 10, 요청 12',   // 개발 응답 · 서버 로그
      details: { available: '10.000000' },      // 외부 응답에 포함
      hint: '동일 재고키 2개 항목이 합산되었습니다.',
      context: { skuId, warehouseId },          // ★ 서버 로그 전용
    });
  }, { route: '/api/skus' });
}
```

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
  "details": { "available": "10.000000", "requestedNet": "12.000000" },
  "hint": "동일 재고키의 2개 항목이 합산되어 검증되었습니다."
}
```

응답 헤더에 `x-request-id` 가 포함됩니다. 요청에 `x-request-id` 가 있으면 그대로 전파하고,
없으면 `x-vercel-id` 를 쓰거나 새로 생성합니다. 제어문자는 제거되고 200자로 잘립니다.

### 내부 로그 ↔ 외부 응답 분리

| 항목 | 운영 응답 | 개발 응답 | 서버 로그 |
|---|:-:|:-:|:-:|
| `message` | 코드별 고정 문구 | 상세 메시지 | 상세 메시지 |
| `details` · `hint` | ✅ | ✅ | ✅ |
| `context` | ❌ | ❌ | ✅ |
| `stack` | ❌ | `debug.stack` | 예상 못한 오류만 |
| `requestId` | ✅ | ✅ | ✅ |

**핵심 원칙**

1. **운영 응답에 DB URL·호스트·포트·환경변수명·스택을 절대 노출하지 않습니다.**
2. `context` 는 어떤 환경에서도 응답에 나가지 않습니다 (서버 로그 전용).
3. **예상하지 못한 오류**(`SystemError`, `EnvironmentError`, 정규화된 일반 `Error`)는
   환경과 무관하게 **고정 문구 + HTTP 500** 입니다. 내부 메시지에 연결 문자열이 섞일 수 있기 때문입니다.
4. 서버 로그에서도 연결 문자열의 자격증명은 `***:***@` 로 마스킹됩니다.
5. 예상 가능한 오류는 `warn`, 예상하지 못한 오류는 `error` 레벨로 기록됩니다.
6. 응답의 `requestId` 로 서버 로그를 찾을 수 있습니다.

### 오류 응답 확인 (개발 전용)

```bash
pnpm dev
curl -s "http://localhost:3000/api/dev/error-preview?kind=domain" | jq
# kind: validation | authorization | conflict | domain | system | unknown
```

> 이 라우트는 **운영환경에서 404** 를 반환합니다.

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
