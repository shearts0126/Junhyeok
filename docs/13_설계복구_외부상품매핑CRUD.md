# 설계복구 — 외부 상품 매핑 CRUD API (T05-2)

> **2026-08-10 External Mapping CRUD Design Recovery Decision**
>
> 이 문서는 `docs/05_API와_화면설계.md` 를 **대체하지 않는다.** 원문에 없거나
> 서로 충돌하는 지점만 확정하고, 그 확정의 근거·범위·후속 의존사항을 기록한다.
> 기존 문서는 삭제·변조하지 않았으며 supersede/reference 만 덧붙였다.
>
> 선행: `docs/12_설계복구_외부상품매핑스키마.md` (T05-1 스키마 결정)

---

## 1. 배경 — T05-2 PRE-FLIGHT BLOCKED

T05-2 착수 전 조사에서 8개 항목의 authoritative 결론이 없어
`T05-2 PRE-FLIGHT BLOCKED` 로 보고했다.

| # | 미결 항목 | 본 문서 |
|---|---|---|
| 1 | `REVIEW_REQUIRED` 행에 code/barcode 를 추가하는 경로 | §2·§6 |
| 2 | `UNMATCHED` 의 실제 의미 | §3 |
| 3 | POST `mappingStatus` 자동판정 truth table | §4 |
| 4 | `warehouseId` API 입력 여부 | §5 |
| 5 | `isPrimary` 충돌·전환 정책 | §9 |
| 6 | `effectiveTo` 매핑 해제 semantics | §8 |
| 7 | read 권한의 Executive 충돌 | §11 |
| 8 | GET 응답 pagination shape | §12 |

본 결정으로 `T05-2 PRE-FLIGHT BLOCKED → T05-2 IMPLEMENTABLE` 로 전환한다.

### 이번 Task 범위 — 정확히 3 endpoint

```text
GET   /api/external-mappings
POST  /api/external-mappings
PATCH /api/external-mappings/{id}
```

⛔ 미착수: `POST /api/external-mappings/import` · `GET /api/external-mappings/unmatched` ·
T05-3 resolver · T05-4 UI · `Warehouse` · `ExternalInventorySnapshot` ·
`ImportJob`/`ImportRow` · `ExternalSystem` CRUD. **stub 도 만들지 않는다.**

`/import` 는 `ImportJob`/`ImportRow`(T15-1)와 업로드 파이프라인(T15-3)이 선행이고,
`/unmatched` 는 "스냅샷·업로드에서 발생한 미매칭"(`05:84`)이라 T17-2(선행 T17-1·
T15-3·**T05-3**)가 생산 주체다. 두 모델 모두 repository 에 없다.

---

## 2. PATCH identifier gap — 원문의 구조적 결함

원문은 서로 맞지 않았다.

| 출처 | 내용 |
|---|---|
| `05:82` PATCH 요청 | `{mappingStatus?, isPrimary?, effectiveTo?}` — **identifier 필드 없음** |
| `05:82` 검증 | `MATCHED` 전환은 외부코드 또는 바코드 필수 |
| `05:344` 화면 상태변화 | `REVIEW_REQUIRED → MATCHED` (외부코드·바코드 **확보 시에만**) |
| `06:189` | 이관 시 상품명-only `REVIEW_REQUIRED` 가 **191건** 생긴다 |

즉 191건이 실제로 존재하는데 **코드를 확보했을 때 넣을 API 가 없다.**
V1 은 PATCH 에 identifier 3종을 열어 이 gap 을 메운다 (§6).

---

## 3. `mappingStatus` server-derived / `UNMATCHED` interactive 금지

### server-managed

`mappingStatus` 는 interactive API 에서 **client 입력이 아니다.**
POST·PATCH body 에 `mappingStatus` 키가 있으면 **400 validation** 이다
(strict DTO 의 unknown field).

```json
{ "mappingStatus": "MATCHED" }   // → 400
```

### `UNMATCHED` — enum 은 유지, interactive 는 금지

`MappingStatus.UNMATCHED` enum 값은 스키마 호환을 위해 **유지한다**(삭제 금지).
그러나 `SkuExternalMapping` interactive CRUD 는:

```text
생성하지 않음 · 전환하지 않음 · 사용자가 지정하지 못함
```

근거: `SkuExternalMapping.skuId` 는 **NOT NULL** 이라 "어느 SKU 에도 매칭되지 않은
외부 행"을 이 테이블로 표현할 수 없다. 실제 미매칭은 ingestion 계층이 표현한다.

```text
ExternalInventorySnapshotLine.matchedSkuId = NULL / matchMethod = 'UNMATCHED'   (03:1590)
InventoryReconciliationLine.skuId = NULL "미매칭이면 NULL"                       (03:1622)
```

⛔ `SkuExternalMapping` 에 가짜 `UNMATCHED` 행을 만들지 않는다.

### 기존 `UNMATCHED` 행 방어

migration/legacy 로 `mappingStatus='UNMATCHED'` 행이 존재하더라도:

- **GET** — 조회 가능. `mappingStatus=UNMATCHED` 필터도 받는다.
- **PATCH** — `422 EXTERNAL_MAPPING_UNMATCHED_NOT_INTERACTIVE`

T05-3/T17 이 의미를 확정하기 전까지 interactive API 가 그 행을 임의 변환하지 않는다.

---

## 4. status truth table

정규화 **후 prospective 값** 기준으로 서버가 파생한다.

| code | barcode | name | 결과 |
|:----:|:-------:|:----:|---|
| O | X | any | `MATCHED` |
| X | O | any | `MATCHED` |
| O | O | any | `MATCHED` |
| X | X | O | `REVIEW_REQUIRED` |
| X | X | X | **422 `EXTERNAL_MAPPING_IDENTIFIER_REQUIRED`** |

`UNMATCHED` 는 어떤 조합에서도 반환되지 않는다.

근거: `05:81`("코드 없이 상품명만이면 `REVIEW_REQUIRED` 강제"),
`05:82`("`MATCHED` 전환은 외부코드 **또는** 바코드 필수"),
`06:188·190`("외부코드 존재 → `MATCHED`").

### 예시

```json
{ "skuId": "...", "externalSystemId": "...", "externalProductName": "외부 상품 A" }
```
→ `REVIEW_REQUIRED`

`externalProductCode = 'P001'` → `MATCHED` ·
`externalBarcode = '880…'` 만 → `MATCHED` ·
전부 없음/blank → `422 EXTERNAL_MAPPING_IDENTIFIER_REQUIRED`

---

## 5. DTO · warehouseId API deferred

### `CreateMappingDto` V1 (strict)

```ts
{
  skuId: string
  externalSystemId: string
  externalProductCode?: string | null
  externalProductName?: string | null
  externalBarcode?: string | null
  isPrimary?: boolean
  note?: string | null
}
```

⛔ 받지 않는다 — `id` · `mappingStatus` · `warehouseId` · `effectiveFrom` ·
`effectiveTo` · `createdAt`.

### `warehouseId` — T08-1 전까지 API 입력 금지

T05-1 DB 에는 `warehouse_id UUID NULL` scalar 가 있으나 **FK 가 없다.**
따라서 API 로 받으면 존재하지 않는 창고 UUID 를 검증할 수단이 전혀 없다.

```text
신규 row: warehouseId = null   (항상)
```

임의 UUID 를 production API 로 저장하는 경로를 만들지 않는다.
T08-1 에서 Warehouse FK/relation 이 생긴 뒤 DTO 개방 여부를 별도 검토한다.

### SKU / ExternalSystem 검증

| 대상 | 규칙 |
|---|---|
| `skuId` | 존재 + `deletedAt IS NULL`. 아니면 **404** |
| SKU status | ⛔ 제한 **없음** — `DRAFT`·`PENDING_APPROVAL`·`ACTIVE`·`INACTIVE` 어느 상태든 매핑 가능. authoritative 근거가 없어 workflow 규칙을 발명하지 않는다 |
| `externalSystemId` | 존재하지 않으면 **404** |
| `ExternalSystem.active` | ⛔ T05-2 에서 **검사하지 않는다**. `active=false` 라는 이유만으로 생성·수정을 차단하지 않는다 — active lifecycle 의 사용 규칙이 문서에 없고 ExternalSystem 관리 API 도 없다. 별도 lifecycle Task 에서 확정 |

---

## 6. external identifier normalization

### `externalProductCode`

```text
string → trim
trim 결과 '' → null
null → null
```

내부 문자(대소문자·앞자리 0·내부 하이픈·내부 공백)는 **변경하지 않는다.**

```text
"  P001  " → "P001"      "00123" → "00123"
"   "      → null        ""      → null
```

⛔ uppercase/lowercase normalization 금지.

> DB 가 `''` 를 허용하는 것은 **migration/raw storage 계약**이다(T05-1 §6).
> interactive API 는 blank 를 `null` 로 canonicalize 해 "값 없음"의 표현을 하나로 고정한다.
> 두 계약을 섞지 않는다.

### `externalProductName`

```text
trim / blank → null
```

내부 공백·문자열은 보존. **어떤 경우에도 `Sku.skuName` UPDATE 로 이어지지 않는다** —
외부 별칭일 뿐이다 (`02:479` ③, PRD §38).

### `externalBarcode`

T04-2 `normalizeBarcode` 를 **그대로 재사용**한다. 새 정규화 규칙을 만들지 않는다.
external-mapping 계층에는 얇은 adapter 만 둔다.

입력은 DTO 에서 `string | null` 만 허용 — numeric JSON 은 400 이다.

| T04-2 결과 | API |
|---|---|
| `EMPTY` | `null` |
| `OK` | 정규화된 바코드 저장 |
| `ERROR/BARCODE_SCIENTIFIC_NOTATION` | 422 `BARCODE_SCIENTIFIC_NOTATION` |
| `ISSUE/BARCODE_UNVERIFIED` | 422 `BARCODE_UNVERIFIED` |
| `ISSUE/BARCODE_INVALID_FORMAT` | 422 `BARCODE_INVALID_FORMAT` |

`BARCODE_READ_AS_NUMBER` 는 numeric JSON 이 DTO 에서 먼저 차단되므로 public
interactive path 에 노출되지 않는다.

---

## 7. 재사용의 범위 — `SkuBarcode` 업무규칙은 가져오지 않는다

`normalizeBarcode` 재사용은 **바코드 문자열 정규화만** 공유한다는 뜻이다.

⛔ `SkuBarcode` 행을 만들지 않는다.
⛔ 활성 중복 검증 · 대표 바코드 · `duplicateException` 을 가져오지 않는다.
⛔ `externalBarcode` 의 UNIQUE 를 application rule 로도 DB constraint 로도 새로
   만들지 않는다 — T05-1 에 해당 invariant 가 없다. 동일 외부 바코드가 여러 매핑에
   매칭될 때의 ambiguity 는 **T05-3 resolver preflight** 에서 확정한다.

---

## 8. effectiveTo / 매핑 해제 semantics

### DELETE 는 없다

원 API 에 DELETE 가 없다. 화면의 "매핑 해제"(`05:343`)는 **PATCH `effectiveTo`** 다.

### V1 지원 방향

```text
null → date   ✅ 지원
date → null   ⛔ 미지원 (재활성)
```

DTO 가 `effectiveTo?: string` 이라 `null` 자체를 받지 않는다.

### 날짜 규칙

입력은 ISO date `YYYY-MM-DD`.

```text
effectiveTo <= 오늘 업무일자(Asia/Seoul)     — 미래일 종료 금지
effectiveFrom 이 non-null 이면 effectiveTo >= effectiveFrom
```

위반은 **422 `EXTERNAL_MAPPING_EFFECTIVE_DATE_INVALID`**.

근거: T05-1 의 `ux_external_mapping_code` predicate 가 `effective_to IS NULL` 을
**"현행"의 정의**로 쓴다. 미래일 종료를 허용하면 "아직 유효하지만 이미 predicate
밖"인 행이 생겨 현행 유일성이 무너진다.

⛔ `effective_from <= effective_to` **DB CHECK 를 추가하지 않는다** — T05-1 결정
유지. 이것은 application 입력 규칙이다. schema/migration 변경 없음.

### 종료된 행은 이력이다

`effectiveTo != null` 인 행의 후속 PATCH 는 **422 `EXTERNAL_MAPPING_ENDED`**.
historical row 를 mutable 하게 만들지 않는다.

### 종료 + code UNIQUE

`effectiveTo` 가 non-null 이 되면 그 행은 `ux_external_mapping_code` predicate
밖으로 나간다. 따라서 종료 성공 후 **동일 system/code 로 새 현행 매핑 생성이 가능**하다.

---

## 9. primary semantics

### 생성

`isPrimary` 기본값은 `false`.
`isPrimary=true` 는 파생된 `mappingStatus = MATCHED` 일 때만 허용된다.
상품명-only(`REVIEW_REQUIRED`)에 `isPrimary=true` →
**422 `EXTERNAL_MAPPING_PRIMARY_REQUIRES_MATCHED`**.

근거: 상품명 기반 매핑은 자동 원장 반영 대상이 아니다(`02:479` ②).

### 충돌 — 자동 해제 없음

동일 `(skuId, externalSystemId)` 에 이미 대표가 있는데 새 row 나 PATCH 가
`isPrimary=true` 를 요구하면 **409 `EXTERNAL_MAPPING_PRIMARY_CONFLICT`**.

⛔ 기존 대표 행을 자동으로 `false` 로 바꾸지 않는다 — 숨은 side effect 금지.
사용자가 기존 대표를 명시적으로 해제한 뒤 새 매핑을 대표로 지정한다.

### `MATCHED → REVIEW_REQUIRED` 로 내려가는 경우

identifier 를 지워 `REVIEW_REQUIRED` 가 되는데 현재 `isPrimary=true` 라면 같은
PATCH 에 `isPrimary:false` 를 함께 명시해야 한다.

```json
{ "externalProductCode": null, "externalBarcode": null, "isPrimary": false }
```

명시하지 않으면 **422 `EXTERNAL_MAPPING_PRIMARY_REQUIRES_MATCHED`**.

### 대표 매핑 종료 — ended primary 문제 해소

현재 `isPrimary=true` 인 행에 `effectiveTo` 를 설정하려면 같은 PATCH 에
`isPrimary:false` 가 **반드시** 있어야 한다.

```json
{ "effectiveTo": "2026-08-10", "isPrimary": false }   // ✅
{ "effectiveTo": "2026-08-10" }                        // ⛔ 422
```

→ **422 `EXTERNAL_MAPPING_PRIMARY_MUST_BE_CLEARED_BEFORE_END`**

이유: T05-1 의 `ux_external_mapping_primary` predicate 는 `effective_to` 를 **보지
않는다**. 종료된 행이 `isPrimary=true` 로 남으면 그 (SKU, 시스템) 조합의 새 대표를
**영구히** 막는다. 명시적 해제를 요구해 그 상태 자체를 만들지 않는다.

⛔ 자동 `isPrimary=false` 변경 금지. ⛔ DB predicate 변경 금지 —
**schema/migration 변경 없음**.

---

## 10. duplicate / primary error mapping

두 partial UNIQUE 를 **별도 public 오류**로 분리한다. generic 409 하나로 합치지 않는다.

| index | 오류코드 | HTTP |
|---|---|:-:|
| `ux_external_mapping_code` | `EXTERNAL_MAPPING_CODE_DUPLICATE` | 409 |
| `ux_external_mapping_primary` | `EXTERNAL_MAPPING_PRIMARY_CONFLICT` | 409 |

### P2002 판별 우선순위

```text
① 구조화된 constraint fields (driverAdapterError.cause.constraint.fields)
② Prisma 표준 meta.target
③ 최후 fallback — originalMessage 의 index 이름
```

두 index 는 모두 2컬럼이지만 컬럼 집합이 다르다:
code = `external_system_id` + `external_product_code`,
primary = `sku_id` + `external_system_id`.
판별은 두 index 를 가르는 **고유 컬럼**(`external_product_code` vs `sku_id`)으로 한다.

⛔ raw DB message substring 을 primary mechanism 으로 쓰지 않는다.
⛔ barcode 의 오류코드를 재사용하지 않는다.

### 신규 public 오류코드 8종

```text
EXTERNAL_MAPPING_CODE_DUPLICATE                      409
EXTERNAL_MAPPING_PRIMARY_CONFLICT                    409
EXTERNAL_MAPPING_IDENTIFIER_REQUIRED                 422
EXTERNAL_MAPPING_PRIMARY_REQUIRES_MATCHED            422
EXTERNAL_MAPPING_PRIMARY_MUST_BE_CLEARED_BEFORE_END  422
EXTERNAL_MAPPING_EFFECTIVE_DATE_INVALID              422
EXTERNAL_MAPPING_ENDED                               422
EXTERNAL_MAPPING_UNMATCHED_NOT_INTERACTIVE           422
```

---

## 11. permission conflict resolution

원문이 충돌했다.

| 출처 | Executive |
|---|---|
| `05:80` API 표 GET 권한 | **전체** (= E 포함) |
| `05:559` / `05_v0.2:656` 화면별 권한 요약 "외부 상품 매핑" | `S=RW L=RW A=RW F=R` **E = —** |

**더 구체적인 화면별 권한표를 채택한다.**

```text
external_mapping.read    ADMIN · SCM_LEADER · SCM_STAFF · FINANCE      (EXECUTIVE 제외)
external_mapping.create  ADMIN · SCM_LEADER · SCM_STAFF
external_mapping.update  ADMIN · SCM_LEADER · SCM_STAFF
```

> 참고: `sku.read`·`barcode.read` 는 화면표에서도 `E = R` 이라 5역할이다 — 다른 사례이며
> 이번 결정이 그것을 바꾸지 않는다.

⛔ `sku.*` 권한 재사용 금지. ⛔ ADMIN bypass 없음 — `RolePermission` 데이터로만 판정.
proxy(1차) + application service `assertPermission`(2차) **double guard**.

### route policy precedence

```text
/api/external-mappings  GET|HEAD           → external_mapping.read
/api/external-mappings  POST               → external_mapping.create
/api/external-mappings  PATCH|PUT|DELETE   → external_mapping.update
```

향후 `/import`·`/unmatched` 특수 route 가 생기면 위 일반 정책보다 **앞에** 배치해야
한다(첫 일치 우선). 이번 PR 에서는 future endpoint policy 를 만들지 않는다.

---

## 12. pagination · filter · q · projection

### 응답 envelope

원문 `Mapping[]` 는 **목록 item type 축약 표기**로 취급한다 — `05:14` 공통 규약이
목록 응답을 envelope 로 정의하고 있고, 이 endpoint 에는 실제 `page` query 가 있다.
shape 은 **현재 repo 의 SKU 목록 계약을 그대로 재사용**한다(새 shape 발명 금지).

```text
{ items, page, pageSize, total, totalPages }
```

### GET query V1

허용: `q` · `externalSystemId` · `skuId` · `mappingStatus` · `page` · `pageSize`.
화이트리스트 밖 키는 **400** (조용히 무시하지 않는다).

⛔ `sort` 는 V1 미지원 — 정렬은 `createdAt DESC, id DESC` 고정.
⛔ `warehouse` 필터는 API 원문에 없고 화면 검색조건에만 있다 → **T08-1 이후**.

`mappingStatus` 필터는 enum 3종을 모두 받는다. interactive API 가 `UNMATCHED` 를
만들지 않으므로 현재는 0건일 수 있으며, 그것은 정상이다.

### `q` scope — 정확히 4종

```text
Sku.skuCode
Sku.skuName
SkuExternalMapping.externalProductCode
SkuExternalMapping.externalProductName
```

⛔ `externalBarcode` 추가 금지 — 화면 검색조건(`05:341`)에 없다.

### item projection

```ts
{
  ...mappingFields,           // warehouseId 포함 (현재 항상 null)
  sku:            { id, skuCode, skuName },
  externalSystem: { id, systemCode, systemName }
}
```

⛔ `warehouse` 객체 없음. ⛔ ExternalSystem 별도 read API 를 발명하지 않는다 —
이 projection 으로 T05-4 가 목록을 그릴 수 있다.
POST·PATCH 응답도 **동일 projection** 이다.

---

## 13. idempotency

`POST /api/external-mappings` 는 원문상 멱등 대상(`05:81` ✅)이다.
**기존 global framework 를 그대로 재사용한다** — 새 framework 금지.

```text
scope       = (actorId, 'POST', routeScope, idempotencyKey)
routeScope  = /api/external-mappings          (경로 파라미터 없음)
hash        = validated raw DTO               (trim/normalization 전)
```

| 상황 | 결과 |
|---|---|
| 최초 | **201** |
| 같은 key + 같은 hash | **200** stored snapshot replay |
| 같은 key + 다른 hash | **409 `IDEMPOTENCY_KEY_REUSED`** |

- DTO 오류(400)·정규화 오류(422)는 **claim 이전에 종료** — key 를 점유하지 않는다.
- business validation 실패(404/422/409)는 **claim 과 함께 롤백** — 실패한 요청이
  key 를 점유하지 않는다.
- mapping INSERT + AuditLog + snapshot 은 **동일 트랜잭션**이다.

⚠️ hash 가 정규화 **전** 값을 쓰므로 `'  P001 '` 과 `'P001'` 은 저장 결과가 같아도
서로 다른 요청이다 — 같은 key 면 409 다. T1-3·T04-3·T04-4A 와 같은 정책이다.

---

## 14. AuditLog

`SkuExternalMapping` 에는 `updatedAt`·`updatedBy` 가 없으므로(T05-1 결정)
변경 추적 수단은 AuditLog 뿐이다.

| 상황 | entityType | action |
|---|---|---|
| POST 성공 | `SkuExternalMapping` | `CREATE` |
| PATCH 실제 변경 | `SkuExternalMapping` | `UPDATE` |
| 매핑 해제(`effectiveTo` 설정) | `SkuExternalMapping` | `UPDATE` |

⛔ `UNMAP`·`DEACTIVATE` 같은 신규 action 을 발명하지 않는다.

- `beforeValue`/`afterValue` 는 view snapshot.
- mutation + AuditLog **동일 트랜잭션**. AuditLog 실패 → mutation 롤백.
- **no-change → AuditLog 없음** (DB write 도 없음).

### PATCH no-change

```text
{}                        → 400 validation
입력은 있으나 정규화·비교 후 변화 없음 → 200 current row / DB UPDATE 0 / AuditLog 0
```

기존 Barcode·SKU convention 과 동일하다.

---

## 15. T05-3 / T05-4 deferred

### T05-3 resolver 호환성

향후 resolver 우선순위는 `① 외부코드 ② 외부바코드 ③ 승인된 상품명 ④ 미매칭` 이다.
T05-2 는 그 구조를 막지 않으며, 다음 구분을 **명확히 고정**한다.

```text
MATCHED          = 외부코드 또는 외부바코드로 식별 가능한 매핑
REVIEW_REQUIRED  = 상품명 기반(name-only) 매핑
```

⛔ **`REVIEW_REQUIRED` 를 자동 원장 반영 가능한 상태로 취급하지 않는다**
(`02:479` ②, 재고 PRD §20.5).

### V1 범위 밖 (미구현 고정)

```text
Warehouse integration / warehouseId filter·input
ExternalSystem lifecycle / ExternalSystem CRUD
import · unmatched endpoint
resolver (T05-3)
mapping UI · bulk mapping (T05-4)
automatic ledger posting · name-based automatic posting
```

### schema / migration

**T05-2 에서 `prisma/schema.prisma` 변경 없음, 신규 migration 없음, 기존 migration
수정 없음.** T05-1 스키마로 충분하다.

---

## 부록 — 확정 계약 요약

| # | 항목 | 확정 |
|---|---|---|
| 1 | endpoint | GET·POST·PATCH 3개 |
| 2 | `mappingStatus` | server-derived. 입력 시 400 |
| 3 | truth table | code∨barcode → MATCHED / name-only → REVIEW_REQUIRED / 없음 → 422 |
| 4 | `UNMATCHED` | enum 유지, interactive 생성·전환 금지. 기존 행 PATCH → 422 |
| 5 | `warehouseId` | API 입력 금지, 항상 `null` (T08-1 이후 재검토) |
| 6 | SKU | 존재 + `deletedAt IS NULL`. status 제한 없음 |
| 7 | ExternalSystem | 존재만 확인. `active` 미검사 |
| 8 | code·name 정규화 | trim, blank → `null`. 내부 문자 보존 |
| 9 | barcode 정규화 | T04-2 재사용. EMPTY → `null`, 3종 422 |
| 10 | PATCH 가능 | code·name·barcode·isPrimary·effectiveTo·note |
| 11 | PATCH 불가 | skuId·externalSystemId(identity) · warehouseId · mappingStatus · effectiveFrom |
| 12 | primary | `MATCHED` 에서만. 자동 해제 없음 → 409 |
| 13 | 종료 | `null → date` 만. `<= 오늘`, `>= effectiveFrom`. 대표는 동시 해제 필수 |
| 14 | 종료된 행 | 후속 PATCH 422 |
| 15 | 409 2종 | code duplicate / primary conflict 분리 |
| 16 | 멱등 | 기존 framework, `routeScope=/api/external-mappings`, hash=raw DTO |
| 17 | 권한 | `external_mapping.read`(A·L·S·F) / `.create` / `.update`(A·L·S) |
| 18 | GET | envelope = SKU 목록 계약, `createdAt DESC, id DESC`, q 4종 |
| 19 | AuditLog | `SkuExternalMapping` + `CREATE`/`UPDATE`, 동일 트랜잭션 |
| 20 | schema | **변경 없음** |
