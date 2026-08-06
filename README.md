# DEEPPOINT SCM OS

구매·발주, 공급계획, 재고, WMS 실행, S&OP를 통합한 내부 SCM 운영 시스템.

> **현재 단계: `R1a-0 / T0-1` — 프로젝트 초기화**
> 데이터베이스·인증·업무 모듈은 아직 구현되지 않았습니다.
> 진행 상황은 [`docs/07_개발백로그와_테스트전략_v0.2.md`](docs/07_개발백로그와_테스트전략_v0.2.md) 참조.

---

## 기술 구성

| 영역 | 기술 | 도입 시점 |
|---|---|---|
| 애플리케이션 | Next.js 16 (App Router) + React 19 + TypeScript 5 | T0-1 ✅ |
| 스타일 | Tailwind CSS 4 + shadcn/ui | T0-1 ✅ |
| 패키지 매니저 | pnpm 10 | T0-1 ✅ |
| 코드 품질 | ESLint 9 (flat config) + Prettier 3 | T0-1 ✅ |
| 테스트 | Vitest 3 | T0-1 ✅ (Testcontainers는 T0-9) |
| 데이터베이스 | PostgreSQL + Prisma | T0-2 |
| 인증 | Supabase Auth | T0-6 |
| 파일 저장 | Supabase Storage | T4-2 (R1a-4) |
| 잡 큐 | pg-boss + 전용 워커 | T4-1 (R1a-4) |
| 배포 | Vercel | — |

---

## 로컬 실행

### 사전 요구사항

- Node.js `>= 20.9.0` (개발 검증: v22.22.2)
- pnpm `>= 10` (개발 검증: v10.33.0)

```bash
# pnpm 미설치 시
corepack enable && corepack prepare pnpm@10.33.0 --activate
```

### 실행

```bash
# 1. 의존성 설치
pnpm install

# 2. 환경변수 준비 (T0-1 시점에는 필수 값 없음)
cp .env.example .env.local

# 3. 개발 서버
pnpm dev
```

- 애플리케이션: http://localhost:3000
- 헬스체크: http://localhost:3000/api/health

```bash
curl -s http://localhost:3000/api/health | jq
```

```json
{
  "status": "ok",
  "service": "deeppoint-scm-os",
  "version": "0.1.0",
  "environment": "development",
  "timestamp": "2026-08-06T04:51:36.215Z",
  "uptimeSeconds": 0,
  "checks": []
}
```

`checks` 는 외부 의존성 점검 결과입니다. T0-1 시점에는 외부 의존성이 없어 비어 있고,
DB(T0-2)·Auth(T0-6)·Storage/Queue(R1a-4) 도입 시 항목이 추가됩니다.

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

> `typecheck` 가 `next typegen` 을 선행하는 이유: Next.js 16은 `LayoutProps` / `PageProps` 등
> 라우트 타입을 `.next/types` 에 생성합니다. `tsc` 단독 실행 시 이 타입을 찾지 못합니다.

---

## 폴더 구조

```
.
├─ docs/                        설계 문서 (v0.1, v0.2, CHANGELOG)
├─ public/                      정적 자산
├─ src/
│  ├─ app/                      Next.js App Router
│  │  ├─ api/health/route.ts    헬스체크 엔드포인트
│  │  ├─ globals.css            Tailwind + shadcn/ui 디자인 토큰
│  │  ├─ layout.tsx             루트 레이아웃
│  │  └─ page.tsx               랜딩 페이지 (T0-1 확인용)
│  ├─ components/
│  │  └─ ui/                    shadcn/ui 컴포넌트 (프로젝트 소유 코드)
│  ├─ lib/
│  │  └─ utils.ts               cn() 유틸
│  ├─ modules/                  도메인 모듈 → src/modules/README.md
│  └─ shared/                   공유 계층 → src/shared/README.md
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
> CLI `init` 대신 동일한 구성(`components.json`, `src/lib/utils.ts`, CSS 토큰, Button)을
> 직접 작성했습니다. 네트워크가 열린 환경에서는 `shadcn add` 가 정상 동작합니다.

---

## 환경변수

`.env.example` 을 `.env.local` 로 복사해 사용합니다. `.env*` 는 커밋되지 않습니다(`.env.example` 만 예외).

T0-1 시점에 필수 값은 없습니다. 아래 항목은 해당 작업에서 채웁니다.

| 변수 | 도입 |
|---|---|
| `DATABASE_URL` (Supavisor pooler), `DIRECT_URL` (직결) | T0-2 |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | T0-6 |
| `SUPABASE_STORAGE_BUCKET_*` | T4-2 |
| `PGBOSS_DATABASE_URL` | T4-1 |

> `DATABASE_URL` 과 `DIRECT_URL` 을 분리하는 이유: Vercel 서버리스에서 커넥션 폭증을 막기 위해
> 런타임은 Supavisor(transaction mode)를 경유하고, `prisma migrate` 와 워커는 직결을 사용합니다.
> transaction-mode pooler 에서는 세션 락(`pg_advisory_lock`)이 동작하지 않으므로,
> 재고 동시성 제어는 반드시 행 잠금(`SELECT ... FOR UPDATE`)으로 구현합니다.

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
