# 설계복구 — 바코드 CRUD API (T04-3)

> **2026-08-10 Barcode CRUD Design Recovery Decision**
>
> 이 문서는 T04-3 구현 계약의 **유일한 근거**다.
> 여기에 없는 규칙을 코드에서 추론해 만들지 않는다.

---

## 1. 배경 — T04-3 PRE-FLIGHT BLOCKED

T04-3 착수 전 preflight 에서 `05_API와_화면설계.md` §10.4 / `05_API와_화면설계_v0.2.md`
§10.5 의 바코드 API 표를 조사한 결과, 구현 계약에 직접 영향을 주는 **6개 항목**이
authoritative 하게 결정되어 있지 않음을 확인했다.

| # | 미결 항목 | 원문 상태 |
|---|---|---|
| 1 | POST DTO | `{barcode, barcodeType, isPrimary?, ...}` — **말줄임표로 끝남** |
| 2 | PATCH DTO | `{isPrimary?, status?, ...}` — **말줄임표로 끝남** |
| 3 | DataIssue 의존성 | repo 에 model·migration·enum·service 가 **전무** |
| 4 | 정규화 실패 HTTP 계약 | `05` 가 `BARCODE_SCIENTIFIC_NOTATION`·`BARCODE_INVALID_FORMAT` 을 언급조차 하지 않음 |
| 5 | 중복 제약 오류 매핑 | `BARCODE_DUPLICATE` 는 DataIssue 코드로만 존재, `BARCODE_PRIMARY_CONFLICT` 는 0건 |
| 6 | `isPrimary` 교체 의미 | 자동 교체/자동 승격/409 어느 쪽도 근거 0건 |

추론 구현을 하지 않고 **STOP** 했으며, 이 문서가 그 빈 부분을 새 결정으로 확정한다.
이로써 T04-3 은 `PRE-FLIGHT BLOCKED` → **`IMPLEMENTABLE`** 로 전환된다.

### 조사 근거 (실측)

```
schema.prisma model 12종 : User Role Permission RolePermission UserRole
                           SystemSetting AuditLog CommonCodeGroup CommonCode
                           Sku SkuBarcode IdempotencyRecord    → DataIssue 없음
schema.prisma enum  2종  : SkuStatus BarcodeType               → IssueStatus 없음
prisma/migrations        : data_issue 문자열 0건
src/                     : DataIssue 생성 경로 0건 (주석·테스트명 hit 만 존재)
```

---

## 2. DataIssue — T04-3 에서 구현하지 않는다

원 API 문구의

> `확인필요`·`확인불가` 는 **거부 + DataIssue**

중 **인터랙티브 CRUD 의 DataIssue 생성 부분을 supersede** 한다.

| 경로 | 잘못된 값 처리 |
|---|---|
| **인터랙티브 Barcode API** (T04-3) | **HTTP 오류 반환. DataIssue INSERT 없음** |
| Excel import · 마이그레이션 · 외부 데이터 수집 | `DataIssue` 요구 **그대로 유효** (미구현, 별도 Task) |

즉 **interactive validation error ≠ persistent imported-data issue** 다.

- ⛔ T04-3 때문에 DataIssue foundation(model·enum·migration·service·API·UI)을
  함께 끌어오지 않는다.
- ⛔ `06_데이터_마이그레이션설계.md` §12.5 의 `BARCODE_UNVERIFIED`·`BARCODE_DUPLICATE`
  DataIssue 정책은 **삭제하지 않는다.** 마이그레이션 문서는 supersede 대상이 아니다.
- T1-4B 의 V7(`BARCODE_SCIENTIFIC_NOTATION`)·V8(`BARCODE_UNVERIFIED`)는 DataIssue
  foundation 이 실제 구현되기 전까지 계속 미완료다.

---

## 3. 권한 — 바코드 전용 capability

신규 permission 4종. **`sku.*` 를 재사용하지 않는다** — 역할집합이 일부 같더라도
바코드는 `02_시스템_아키텍처와_모듈구조.md` §478 의 독립 모듈 capability 다.

| permission | 역할 |
|---|---|
| `barcode.read` | ADMIN · SCM_LEADER · SCM_STAFF · FINANCE · EXECUTIVE |
| `barcode.create` | ADMIN · SCM_LEADER · SCM_STAFF |
| `barcode.update` | ADMIN · SCM_LEADER · SCM_STAFF |
| `barcode.deactivate` | ADMIN · SCM_LEADER · SCM_STAFF |

- ⛔ 재사용 금지: `sku.read` · `sku.create` · `sku.update` · `sku.deactivate`
- ⛔ `barcode.approve_duplicate` (T04-4, ADMIN·SCM_LEADER)는 **아직 만들지 않는다.**
- ADMIN bypass 없음. Proxy(1차) + Application Service(2차) **이중 guard**.

---

## 4. Route policy 우선순위

바코드 경로가 일반 `/api/skus` 정책에 fall-through 하면 안 된다.
**바코드 정책을 일반 SKU 정책보다 앞에** 둔다 (첫 일치 우선).

| 경로 · 메서드 | permission |
|---|---|
| `GET /api/skus/{id}/barcodes` | `barcode.read` |
| `POST /api/skus/{id}/barcodes` | `barcode.create` |
| `PATCH /api/skus/{id}/barcodes/{bid}` | `barcode.update` |
| `DELETE /api/skus/{id}/barcodes/{bid}` | `barcode.deactivate` |

컬렉션과 단건이 서로 다른 깊이에 있으므로 `suffix` 로는 구분되지 않는다 —
정책에 `contains: '/barcodes'` 조건을 둔다.

---

## 5. POST DTO — V1 최소 계약

```ts
z.strictObject({
  barcode: z.string(),            // 필수
  barcodeType: z.enum(BARCODE_TYPES),  // 필수
  isPrimary: z.boolean().optional(),   // 기본 false
})
```

`barcodeType` 허용값은 T04-1 enum 그대로 `UNIT` · `INNER_BOX` · `OUTER_BOX` ·
`CHANNEL` · `LEGACY`. unknown field → **400**.

### V1 POST 에서 받지 않는 필드

| 구분 | 필드 | 사유 |
|---|---|---|
| future extension | `countryCode` · `channelCode` · `effectiveFrom` · `effectiveTo` | API 입력 근거 불충분 |
| server-managed | `id` · `skuId` · `status` · `createdAt` | 서버가 정한다 (`skuId` 는 경로가 유일 출처) |
| T04-4 전용 | `duplicateException` · `exceptionReason` · `approvedBy` | 일반 POST 로 중복 예외를 만들 수 없어야 한다 |

---

## 6. PATCH DTO — V1 최소 계약

```ts
z.strictObject({
  isPrimary: z.boolean().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
}).refine(최소 하나 필수)
```

`{}` → **400**.

수정 금지: `barcode` · `barcodeType` · `countryCode` · `channelCode` ·
`effectiveFrom` · `effectiveTo` · `duplicateException` · `exceptionReason` ·
`approvedBy` · `skuId` · `id` · `createdAt`.

### barcode 값은 immutable

한 번 생성된 `SkuBarcode.barcode` 는 일반 PATCH 로 수정하지 않는다.
잘못 등록했다면 **기존 바코드 DELETE(→ `INACTIVE`) 후 새 바코드 POST(→ 새 row)** 다.
그래야 과거 바코드 사용 이력이 보존된다. `barcodeType` 도 V1 PATCH 대상이 아니다.

---

## 7. 부모 SKU · 소유권

- 경로 `/api/skus/{skuId}/…` 의 `skuId` 가 **authoritative parent** 다.
  body 로 `skuId` 를 받지 않는다.
- 부모 SKU 가 없으면(또는 soft-delete) 기존 not-found convention 으로 **404**.
- ⛔ SKU 상태 기반 제한(`DRAFT only` · `ACTIVE only` · `ARCHIVED block` ·
  `hasTransaction block`)을 **추가하지 않는다** — authoritative 근거가 없다.
  `hasTransaction` 은 `skuCode` 변경 규칙이지 바코드 CRUD 규칙이 아니다.
- `/api/skus/A/barcodes/B` 에서 `B` 가 다른 SKU 의 바코드면 수정할 수 없다.
  조회 조건은 `id = barcodeId AND skuId = path skuId` 이며 불일치는 **404** 다 —
  다른 SKU 의 바코드 존재 여부를 노출하지 않는다.

---

## 8. 정규화 연결 · HTTP 계약

POST 는 T04-2 `normalizeBarcode(raw)` 를 반드시 사용한다. 단 **Zod strict DTO 가 먼저** 실행된다.

| T04-2 결과 | HTTP |
|---|---|
| `EMPTY` (`''` · `-` · `—` · 공백만) | **204 No Content** — 저장 없음, 오류 아님 |
| `OK` | 201 (멱등 replay 는 200) |
| `ERROR / BARCODE_SCIENTIFIC_NOTATION` | **422 `BARCODE_SCIENTIFIC_NOTATION`** — 복원 시도 없음 |
| `ISSUE / BARCODE_UNVERIFIED` | **422 `BARCODE_UNVERIFIED`** |
| `ISSUE / BARCODE_INVALID_FORMAT` | **422 `BARCODE_INVALID_FORMAT`** |

세 코드를 shared public error catalog 에 추가한다. 어느 경우에도 DataIssue 는 없다.

### `BARCODE_READ_AS_NUMBER` 는 공개 오류코드가 아니다

`{"barcode": 8809619961373}` 은 Zod 에서 **400** 이며 도메인 정규화까지 가지 않는다.
`BARCODE_READ_AS_NUMBER` 는 Excel/import parser 검증용 도메인 결과값으로만 유지한다.

### EMPTY 와 `{}` 의 구분

| 요청 | 결과 |
|---|---|
| `{ barcode: "-" , barcodeType: "UNIT" }` | **204** |
| `{}` (필드 자체 누락) | **400** |

---

## 9. DB 길이 경계

T04-2 가 길이 업무규칙을 갖지 않는다는 결정은 유지한다. 다만 DB 는 `VARCHAR(100)` 이므로
정규화 결과가 `OK` 여도 `barcode.length > 100` 이면 INSERT 전에 **400** (field error `barcode`)
로 거부한다. 새 EAN 길이 규칙을 만드는 것이 아니라 **DB 물리 용량을 API 에서 안전하게
노출**하는 것뿐이다. ⛔ 체크디지트·EAN-13 검증 금지.

---

## 10. 멱등성 (POST 전용)

기존 generic idempotency infrastructure(T1-3 보완)를 **그대로 재사용**한다. 새 framework 금지.

- `routeScope = '/api/skus/{id}/barcodes'` — **raw UUID 를 넣지 않는다** (route template).
- request hash = `{ skuId, ...validatedRawDto }`.
  ★ **정규화 전 원 입력**을 해싱한다 — semantic normalization 없음.
  따라서 `'001-234'` 와 `'001234'` 는 정규화 결과가 같아도 hash 가 다르며,
  같은 key 면 **409 `IDEMPOTENCY_KEY_REUSED`** 다.
- first → **201** / same key + same hash → **200 replay** / same key + different hash → **409**.

### EMPTY 는 멱등기록을 만들지 않는다

`EMPTY` · `ERROR` · `ISSUE` 는 **claim 이전에 종료**된다. mutation 이 시작되지 않은
검증 실패 요청은 IdempotencyRecord 를 남기지 않는다(SKU create 와 같은 원칙).
따라서 사용자가 같은 key 로 정상 값을 다시 제출할 수 있다.

### 원자성

정상 create 는 **하나의 DB 트랜잭션**이다:
`멱등 claim → SkuBarcode INSERT → AuditLog INSERT → 멱등 snapshot`.
AuditLog 실패 → 전부 롤백. snapshot 실패 → 전부 롤백. (T1-3 패턴 그대로)

### PATCH · DELETE

문서상 멱등 대상은 POST 뿐이므로 PATCH·DELETE 에 `Idempotency-Key` 인프라를 붙이지 않는다.
DELETE 의 반복 안전성은 application state semantics 로 처리한다(§12).

---

## 11. 중복 · 대표 충돌

T04-1 조건부 UNIQUE 2종이 **최종 방어선**이다.

| 위반 인덱스 | HTTP |
|---|---|
| `ux_barcode_active` (`UNIQUE(barcode) WHERE status='ACTIVE' AND duplicate_exception=false`) | **409 `BARCODE_DUPLICATE`** |
| `ux_barcode_primary` (`UNIQUE(sku_id) WHERE is_primary=true AND status='ACTIVE'`) | **409 `BARCODE_PRIMARY_CONFLICT`** |

두 코드 모두 신규 public error code 다.

구분은 P2002 의 **구조화된 제약 컬럼 목록**(`["barcode"]` vs `["sku_id"]`)을 1차 계약으로 쓴다.
어댑터 `originalMessage` 문자열(인덱스 이름) 파싱은 **최후 fallback** 일 뿐 1차 계약이 아니다.

### 금지 — 숨은 side effect

- ⛔ 자동 `duplicateException=true` · 자동 승인 · 기존 바코드 자동 비활성
- ⛔ 새 대표 지정 시 기존 대표 **자동 해제**

예: SKU A 에 `barcode X (ACTIVE, primary)` 가 있는 상태에서
`POST barcode Y isPrimary=true` → **409 `BARCODE_PRIMARY_CONFLICT`**.
`PATCH barcode Y isPrimary=true` 도 동일. 사용자가 기존 대표를 명시적으로
`PATCH isPrimary=false` 한 뒤 새 대표를 지정해야 한다.

### 활성 대표 0개 허용

DB 는 "**최대** 1개"를 강제하지 "정확히 1개"를 강제하지 않는다. 활성 대표가 0개인 SKU
상태를 허용하며, 대표 바코드를 DELETE 해도 다른 바코드를 자동 승격하지 않는다.

---

## 12. status · 재활성 · DELETE

### status PATCH

`ACTIVE ↔ INACTIVE` 양방향 허용. 재활성 시 partial UNIQUE 2종이 다시 적용되므로
그 사이 다른 SKU 가 같은 값을 활성으로 쓰고 있었다면 **409 `BARCODE_DUPLICATE`**,
이미 활성 대표가 있다면 **409 `BARCODE_PRIMARY_CONFLICT`** 가 발생할 수 있다. **자동 해결 없음.**

### 변화 없음 (PATCH)

요청 결과가 현재 값과 완전히 같으면 **200 + 현재 행**. DB UPDATE 없음, AuditLog 없음.
(`SkuBarcode` 에는 `updatedAt` 조차 없으므로 no-op write 를 만들 이유가 없다.)

### DELETE

`status = 'INACTIVE'` 만 수행한다. **물리 DELETE 금지.** 응답 **200 + SkuBarcode**.

- 이미 `INACTIVE` 면 재호출도 **200 + 현재 행** 으로 idempotent success 다.
  DB UPDATE 없음, AuditLog 없음, **409/422 를 반환하지 않는다.**
- 현재 행이 `isPrimary=true, status=ACTIVE` 여도 DELETE 가능하다. 결과는
  `isPrimary=true, status=INACTIVE` 로 **`isPrimary` 를 자동으로 내리지 않는다** —
  과거에 대표였다는 이력으로 남는다. partial index 는 `status='ACTIVE'` 조건이라 충돌하지 않는다.

---

## 13. GET 목록 계약

구체 endpoint 계약이 일반 collection pagination 규약(`{items, page, …}`)보다 우선한다.

```
GET /api/skus/{id}/barcodes  →  SkuBarcode[]  (raw array)
```

- pagination 없음 · query filter 없음.
- **`ACTIVE`·`INACTIVE` 모두 포함**. DELETE 가 물리삭제가 아니라 비활성 이력을 남기므로
  조회 API 가 이를 볼 수 있어야 한다. ⛔ ACTIVE-only 를 만들지 않는다.
- 결정적 정렬: **`createdAt DESC, id DESC`**.
  ⛔ `SkuBarcode` 에는 `updatedAt` 이 없으므로 그 기준 정렬을 발명하지 않는다.
- 부모 SKU 가 없으면 빈 배열이 아니라 **404**.

---

## 14. AuditLog

바코드 변경 `CREATE` · `UPDATE` · `DEACTIVATE` 를 전부 기록한다.
업무 변경과 **같은 트랜잭션**이며, 감사로그가 실패하면 변경도 롤백된다.

| 항목 | 값 |
|---|---|
| `entityType` | `SkuBarcode` |
| `entityId` | `barcode.id` |
| `action` | `CREATE` / `UPDATE` / `DEACTIVATE` |
| `beforeValue` / `afterValue` | 실제 `SkuBarcode` 업무 필드 snapshot |

`skuId` 는 row 자체에 있으므로 snapshot 에 자연스럽게 포함된다.
⛔ `parentSkuId` 같은 AuditLog 컬럼을 추가하지 않는다.
`GET /api/skus/{id}/history` 에서 바코드 이력을 합치는 방법은 **T1-6B history aggregation**
에서 결정한다.

---

## 15. T04-4 필드 보호

일반 POST/PATCH 에서 `duplicateException` · `exceptionReason` · `approvedBy` 는 **항상 400** 이다.
T04-4 전용이며, DB fixture 외에 production path 에서 `duplicateException=true` 를 만들 수단이
아직 존재하지 않아야 한다.

---

## 16. 범위 밖 (T04-3 에서 착수하지 않음)

`T04-4 중복 예외 승인` · `Barcode UI` · `T1-4B(V7~V9 연결)` · `T1-5B` · `T1-6B` ·
`DataIssue foundation` · `import/migration` · `external mapping` · `BOM`.

`SkuBarcode` schema 변경과 새 migration 도 없다 (permission seed 수정만 허용).

---

## 부록 — 확정 계약 요약

| Method | URL | 요청 | 성공 응답 | permission | 멱등 |
|---|---|---|---|---|:-:|
| GET | `/api/skus/{id}/barcodes` | — | `200 SkuBarcode[]` | `barcode.read` | — |
| POST | `/api/skus/{id}/barcodes` | `{barcode, barcodeType, isPrimary?}` | `201 SkuBarcode` / `200 replay` / `204 EMPTY` | `barcode.create` | ✅ |
| PATCH | `/api/skus/{id}/barcodes/{bid}` | `{isPrimary?, status?}` | `200 SkuBarcode` | `barcode.update` | — |
| DELETE | `/api/skus/{id}/barcodes/{bid}` | — | `200 SkuBarcode` (INACTIVE) | `barcode.deactivate` | — |

| 상황 | 오류 |
|---|---|
| unknown field · `{}` · 숫자 barcode · 정규화 결과 >100자 | 400 `VALIDATION_ERROR` |
| 권한 없음 | 403 `FORBIDDEN` |
| 부모 SKU 없음 · 다른 SKU 의 barcodeId | 404 `NOT_FOUND` |
| 활성 일반 바코드 중복 | 409 `BARCODE_DUPLICATE` |
| 활성 대표 중복 | 409 `BARCODE_PRIMARY_CONFLICT` |
| 같은 멱등키 + 다른 내용 | 409 `IDEMPOTENCY_KEY_REUSED` |
| 지수표기 | 422 `BARCODE_SCIENTIFIC_NOTATION` |
| 확인필요·확인불가·확인 필요·바코드 | 422 `BARCODE_UNVERIFIED` |
| 숫자 전용 아님 | 422 `BARCODE_INVALID_FORMAT` |
