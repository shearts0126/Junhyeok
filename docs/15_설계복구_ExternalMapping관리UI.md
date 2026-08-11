# 설계복구 — 외부 상품 매핑 관리 UI (T05-4A)

> **2026-08-11 External Mapping Management UI Design Recovery Decision**
>
> 이 문서는 기존 설계 문서를 **삭제·변조하지 않는다.** 원문에 없거나 서로
> 충돌하는 지점만 확정하고, 그 확정의 근거·범위·후속 의존사항을 기록한다.
>
> 선행: `docs/12`(T05-1 스키마) · `docs/13`(T05-2 CRUD) · `docs/14`(T05-3 resolver)

---

## 1. 배경 — T05-4 PRE-FLIGHT 결과

T05-4 의 authoritative 화면 설계는 `05:339~347` **§11.6 6행**이 전부였고,
완료조건("미매칭 해소 동작", `07:81`)이 가리키는 세 축이 모두 미정의였다.

| 미결 | 실측 |
|---|---|
| `/unmatched` 의 source | `UnmatchedRow` 타입 정의 없음. 후보 모델(`ExternalInventorySnapshotLine`·`ImportRow`·`DataIssue`) **전부 미구현** |
| `/import` | `05:83` 은 비동기(`202 {jobId}`), `05_v0.2:123` 은 "동기 업로드" — **상충**. `ImportJob`/`ImportRow`(T15-1)·파이프라인(T15-3) 없음 |
| "일괄 매핑(SKU 선택)" | 문구 하나뿐, 동작 6개 후보 |
| E2E·TC | 외부매핑 시나리오·TC 번호 **없음** |
| ExternalSystem 선택 수단 | 조회 API 자체가 없음 |
| 목록 열 `최종수정`·`창고` | `updatedAt` 컬럼 없음 / `warehouseId` FK 없음(T08-1) |

→ `T05-4 PRE-FLIGHT BLOCKED` 판정.

### Task 분할

```text
T05-4A  External Mapping 기본 관리 UI      → IMPLEMENTABLE (본 문서)
T05-4B  unmatched / bulk mapping / import  → DEFERRED
```

**T05-4B 는 T15·T17 선행 계약이 확보되기 전에는 구현하지 않는다.**
선행 모델이 repository 에 없고, 어느 데이터에서 "미매칭"을 읽어야 하는지조차
확정되지 않았기 때문이다.

---

## 2. T05-4A exact scope

구현한다.

```text
/master/external-mappings 목록 · 검색/필터 · 신규 매핑 · 수정 · 매핑 해제
REVIEW_REQUIRED 표시 · ExternalSystem lookup GET · page permission
기존 T05-2 CRUD 연동
```

⛔ 구현하지 않는다.

```text
/unmatched · unmatched 전용 화면 · "미매칭만 보기" 버튼
bulk mapping · 일괄 매핑 · Excel/CSV import · /import
resolver REST API · approval workflow · DataIssue · InventoryException
T15 · T17 · warehouse filtering · External Mapping schema 변경
```

---

## 3. 화면 ID · Route

| 항목 | 값 |
|---|---|
| Screen ID | **`EXT-MAP-001`** |
| Route | `/master/external-mappings` |

⛔ `/master/external-mappings/new` · `/master/external-mappings/{id}` 를 만들지 않는다.
신규·수정은 **목록 화면 내 dialog** 다. 별도 detail page 도 없다.

---

## 4. Page permission

진입 권한은 **`external_mapping.read`** — 현재 seed 그대로
`ADMIN · SCM_LEADER · SCM_STAFF · FINANCE`. **EXECUTIVE 제외**(docs/13 §11).
⛔ ADMIN bypass 없음. proxy(1차) + application service(2차) 이중 방어 유지.

mutation 버튼은 `/api/me` permissions 로 제어한다 — **역할 이름을 UI 에
하드코딩하지 않는다.**

```text
신규 매핑        → external_mapping.create
수정 · 매핑 해제  → external_mapping.update
```

---

## 5. ExternalSystem 선택수단 Recovery

신규 매핑에서 `externalSystemId` 가 필수인데 고를 수단이 없었다.
T05-4A supporting API 로 **최소 read endpoint** 를 추가한다.

```text
GET /api/external-systems
```

이 결정은 `docs/13` §12 의 "별도 ExternalSystem read API 를 발명하지 않는다"를
**T05-4A 에 한해 좁게 supersede** 한다. 목적은 관리 UI 의 lookup 제공뿐이다.

---

## 6. ExternalSystem GET contract

```ts
{
  items: Array<{
    id: string;
    systemCode: string;
    systemName: string;
    systemType: string;
    active: boolean;
  }>;
}
```

- pagination 없음 · query parameter 없음. 알 수 없는 파라미터는 **400**
  (기존 strict request convention 동일).
- 정렬: `systemCode ASC` → `id ASC`.
- **모든 ExternalSystem 을 반환한다. `active=false` 도 숨기지 않는다.**

근거: T05-2 backend 가 active restriction 을 두지 않으므로(`docs/13` §5)
**UI 가 backend 보다 새로운 business restriction 을 만들지 않는다.**
화면은 `(비활성)` 정도의 상태 표시만 하고 **선택 자체를 금지하지 않는다.**
새 lifecycle rule 을 만들지 않는다.

---

## 7. ExternalSystem API permission

권한은 **`external_mapping.read`** 를 그대로 쓴다 — ⛔ 신규 permission 을 만들지 않는다.
roles: `ADMIN · SCM_LEADER · SCM_STAFF · FINANCE`. double guard 적용, ADMIN bypass 없음.
**Audit 없음 · Idempotency 없음 · read-only.**

---

## 8. ExternalSystem API architecture

```text
Route → Application Service → Repository/Prisma
```

business/data access 를 route 에 직접 넣지 않는다.
⛔ ExternalSystem **CRUD 를 만들지 않는다** — 허용되는 것은 lookup GET 하나뿐이다.

---

## 9. SKU 선택 범위

기존 **`GET /api/skus`** 를 재사용한다.

⛔ T05-4A 에서 별도의 SKU status eligibility rule 을 추가하지 않는다.

```text
ACTIVE only 필터 강제 금지
INACTIVE / DISCONTINUED 차단 규칙 추가 금지
ARCHIVED / deleted 를 노출하려는 API 확대도 금지
```

핵심: **UI 는 기존 SKU API 보다 좁거나 넓은 새 business eligibility 를 만들지 않는다.**
현재 매핑이 가리키는 SKU 정보는 목록 projection 그대로 표시한다.

---

## 10. identity 는 immutable

| 필드 | 신규 | 수정 |
|---|---|---|
| `skuId` | 선택 가능 | **변경 UI 없음** (read-only 표시) |
| `externalSystemId` | 선택 가능 | **변경 UI 없음** (PATCH DTO 에도 없다) |

다른 SKU·시스템으로 옮기려면 **기존 매핑 종료 → 신규 생성**이다.
⛔ PATCH contract 를 확대하지 않는다.

---

## 11. 목록 필터

지원: `q` · `externalSystemId` · `skuId` · `mappingStatus` · `page` · `pageSize`
— **현재 GET contract 그대로**다.

⛔ 미지원: `warehouseId` · `sort` · `updatedAt` filter · unmatched 전용 pseudo-filter.

URL searchParams 가 source of truth 다. 기존 SKU 목록 convention 처럼
**UI 가 모르는 query parameter 를 조용히 제거해 정상화하지 않는다** — backend
strict validation 결과(400)를 error state 로 그대로 보여준다.

---

## 12. 목록 열

```text
① 외부시스템 ② 외부코드 ③ 외부상품명 ④ 외부바코드 ⑤ SKU 코드
⑥ 표준 상품명 ⑦ 매핑상태 ⑧ 대표 ⑨ 적용기간 ⑩ 작업
```

- **`최종수정` 열 제거** — `updatedAt` schema 가 없다. 임의로 "최근 변경일"을
  계산하지 않는다.
- **`창고` 열 없음** — `warehouseId`/T08-1 은 future scope.
- **정렬 UI 없음** — backend 고정 정렬 `createdAt DESC, id DESC` 를 그대로 쓴다.

---

## 13. "미매칭만 보기" — T05-4B

T05-4A 에서 **구현하지 않는다.** 그 문구를 `UNMATCHED` / `REVIEW_REQUIRED` /
resolver `AMBIGUOUS` / `CONFLICT` 중 **어느 것으로도 재해석하지 않는다.**
T05-4B recovery 필요 항목으로 남긴다.

일반 `mappingStatus` 필터에는 기존 enum 3종(`MATCHED` · `REVIEW_REQUIRED` ·
`UNMATCHED`)을 그대로 둔다. `UNMATCHED` 가 현재 0건이어도 **UI 가 의미를 바꾸지 않는다.**

---

## 14. REVIEW_REQUIRED UX

T05-2/T05-3 계약을 **그대로 시각화**한다. `mappingStatus === 'REVIEW_REQUIRED'` 면
눈에 띄는 badge 를 표시하고, 다음 의미를 전달한다.

> 상품명 기반 매핑입니다. 자동 원장 반영 대상이 아닙니다.
> 외부코드 또는 바코드를 추가하면 MATCHED 로 전환할 수 있습니다.

⛔ 승인 버튼 없음 · confirm action 없음 · review API 없음 · approval workflow 없음.

사용자가 edit 에서 `externalProductCode` 또는 `externalBarcode` 를 추가해 저장하면
**T05-2 server-derived status 가 MATCHED 로 바뀌는 방식만** 쓴다.
⛔ UI 가 status 를 직접 PATCH 하지 않는다.

---

## 15. 신규 매핑 UX

create 권한이 있을 때만 `신규 매핑` 버튼이 보인다. dialog 의 편집 필드는 정확히:

```text
externalSystemId · skuId · externalProductCode · externalProductName
externalBarcode · isPrimary · note
```

⛔ server-managed(`id`·`mappingStatus`·`effectiveFrom`·`effectiveTo`·`createdAt`)와
`warehouseId` 를 입력으로 보내지 않는다. POST DTO 는 T05-2 contract 그대로이며
새 필드를 추가하지 않는다.

⚠️ trim·blank→null canonicalization 은 **서버가 한다.** UI 는 입력값을 그대로
보내고 서버 판정(422 `EXTERNAL_MAPPING_IDENTIFIER_REQUIRED` 등)을 표시한다 —
UI 가 서버 판정을 앞질러 막지 않는다.

### POST idempotency

기존 T05-2 멱등을 그대로 쓴다. 사용자가 `저장`을 눌러 시작한 **하나의 logical
create attempt** 동안 같은 `Idempotency-Key` 를 유지한다(network retry 는 같은 키).
검증 오류를 고쳐 **새 저장 attempt 를 명시적으로 시작하면 새 키**다.
generic idempotency semantics 를 변경하지 않는다.

---

## 16. 수정 UX

목록 row 의 `수정` action 으로 dialog 를 연다.
⛔ `GET /api/external-mappings/{id}` 를 만들지 않는다 — **현재 list projection 을
dialog 초기값으로** 쓴다.

편집 가능: `externalProductCode` · `externalProductName` · `externalBarcode` ·
`isPrimary` · `note`.
read-only 표시: `skuId` · `externalSystemId` · `mappingStatus`.

`effectiveTo` 는 일반 edit form 의 날짜 입력으로 노출하지 않는다 — 매핑 종료는
별도 action 이다(§17).

**변경분만 PATCH 한다.** 바뀐 것이 없으면 **PATCH 자체를 호출하지 않는다**
(서버 no-change 200 에 의존하지 않는다).

---

## 17. 매핑 해제 UX

행 action `매핑 해제`. T05-2 lifecycle 의 `effectiveTo` 종료 semantics 를 쓴다.
확인하면 **업무일자(Asia/Seoul) 오늘 날짜**를 `YYYY-MM-DD` 로 보낸다 —
repository 에 이미 있는 `businessDateOf`(`effective-date.ts`)와 **같은 규칙**이며,
새 timezone utility 를 만들지 않는다(unit 테스트가 두 값의 일치를 고정).

```jsonc
// 현재 row 가 isPrimary=true 이면
{ "isPrimary": false, "effectiveTo": "2026-08-11" }
// 그 외
{ "effectiveTo": "2026-08-11" }
```

종료 후 목록을 refetch 한다. ⛔ **physical DELETE 금지.**

### 종료된 매핑

`effectiveTo !== null` 인 행은 목록에 **그대로 나타난다**(이력).
T05-2 가 재수정을 422 `EXTERNAL_MAPPING_ENDED` 로 막으므로 UI 는
**수정·매핑 해제 action 을 노출하지 않는다.** ⛔ reactivate UI 를 만들지 않는다 —
필요하면 새 매핑을 생성한다.

> 같은 이유로 `mappingStatus='UNMATCHED'` 행도 action 을 노출하지 않는다
> (T05-2 `EXTERNAL_MAPPING_UNMATCHED_NOT_INTERACTIVE`).

---

## 18. Error UX

loading · empty · 400 · 403 · 404 · 409 · 422 · 500 을 **구분해서** 보여준다.
기존 `readApiError` · `ErrorBanner` convention 을 재사용하며
⛔ **403 을 empty state 로 표시하지 않는다.**

기존 public error code 를 **새 코드로 바꾸지 않는다**:
`EXTERNAL_MAPPING_CODE_DUPLICATE` · `PRIMARY_CONFLICT` · `IDENTIFIER_REQUIRED` ·
`PRIMARY_REQUIRES_MATCHED` · `PRIMARY_MUST_BE_CLEARED_BEFORE_END` ·
`EFFECTIVE_DATE_INVALID` · `ENDED` · `UNMATCHED_NOT_INTERACTIVE` ·
`IDEMPOTENCY_KEY_REUSED`.

### Warning UX

설계 근거가 있는 warning 은 **REVIEW_REQUIRED / 상품명 기반 자동반영 불가 하나뿐**이다.
⛔ duplicate barcode · inactive SKU · historical · future-effective warning 을
발명하지 않는다(일반 상태 표시는 가능하되 business warning 으로 확대하지 않는다).

---

## 19. Existing UI convention

T1-5A/T1-6A 패턴을 우선 재사용한다 — `page.tsx` + `Suspense`, client component
분리, URL searchParams source of truth, `/api/me` permissions(역할 하드코딩 없음),
loading/empty/error 구분, `readApiError`, `ErrorBanner`, 기존 form/button primitive.
⛔ CommonCode lookup 을 ExternalSystem 에 쓰지 않는다.

---

## 20. Schema / Migration

T05-4A 에서 **전부 금지**이며 실제로 변경하지 않았다.

```text
SkuExternalMapping schema · ExternalSystem schema · migration 추가
updatedAt 추가 · warehouse FK 추가 · approval fields 추가 · MappingStatus 변경
```

ExternalSystem lookup API 는 **현 schema read 만** 한다.

---

## 21. T05-4B deferred scope

```text
unmatched : GET /api/external-mappings/unmatched · UnmatchedRow ·
            미매칭 데이터 source · resolver AMBIGUOUS/CONFLICT persistence
bulk      : 일괄 매핑 API · multi-select bulk mutation · bulk resolver exposure
import    : POST /api/external-mappings/import · Excel/CSV parser · template ·
            ImportJob · ImportRow · worker · async pipeline
```

⛔ T15/T17 을 선구현하지 않는다.

### T05-4B 착수 전 필요한 결정

1. `UnmatchedRow` 의 실체와 source 모델 (T17-1 선행)
2. `/import` 동기·비동기 상충 해소 + T15 파이프라인 계약
3. "일괄 매핑"의 정확한 동작
4. bulk/import 의 audit·멱등 단위(행 단위 vs 잡 단위)
5. "미매칭만 보기" 버튼의 의미
6. T05-4B acceptance / E2E 시나리오

---

## 22. T05-4A Acceptance contract

| # | 내용 |
|---|---|
| **AC-1** Read | `external_mapping.read` 사용자는 `/master/external-mappings` 목록을 조회할 수 있다. 권한 없으면 403 |
| **AC-2** Finance | FINANCE 는 조회 가능. 신규/수정/해제 mutation UI 가 노출되지 않는다 |
| **AC-3** Create | create 권한 사용자는 ExternalSystem + SKU + identifiers 를 골라 신규 매핑을 만들 수 있다 |
| **AC-4** REVIEW_REQUIRED | name-only 생성 결과에 badge 가 나타나고 자동 원장 반영 불가 문구를 확인할 수 있다 |
| **AC-5** Resolve review | REVIEW_REQUIRED 매핑에 외부코드·바코드를 edit 로 추가하면 backend-derived `MATCHED` 를 refetch 해 표시한다 |
| **AC-6** Edit | 허용 필드만 수정 가능. SKU·externalSystem·status 는 직접 수정 불가 |
| **AC-7** End | 매핑 해제는 physical delete 없이 `effectiveTo` 설정. primary 행은 같은 PATCH 에서 `isPrimary=false` |
| **AC-8** Ended | 종료 매핑은 수정·해제 불가. reactivate UI 없음 |
| **AC-9** Filters | `q`/`externalSystemId`/`skuId`/`mappingStatus`/pagination 이 URL state 와 API 에 일치 |
| **AC-10** Error | 400/403/409/422/500 을 empty 로 숨기지 않는다 |
| **AC-11** No future leakage | unmatched/bulk/import/resolve REST/T15/T17 기능이 존재하지 않는다 |
