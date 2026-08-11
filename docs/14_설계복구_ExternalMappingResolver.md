# 설계복구 — 외부 상품 매핑 SKU 해석 서비스 (T05-3)

> **2026-08-10 External Mapping Resolver Design Recovery Decision**
>
> 이 문서는 기존 설계 문서를 **삭제·변조하지 않는다.** 원문에 없거나 서로
> 충돌하는 지점만 확정하고, 그 확정의 근거·범위·후속 의존사항을 기록한다.
> 기존 문서에는 supersede/reference 만 덧붙였다.
>
> 선행: `docs/12_설계복구_외부상품매핑스키마.md`(T05-1) ·
>       `docs/13_설계복구_외부상품매핑CRUD.md`(T05-2)

---

## 1. 배경 — T05-3 PRE-FLIGHT BLOCKED

T05-3 의 authoritative 근거는 **7곳의 한 줄짜리 요약**뿐이었다 —
`07:80`, `07_v0.2:104`, `02:307`, `02:324`, `02:479`, `05:487`, `05_v0.2:125`.
resolver 알고리즘·request/response 정의는 어디에도 없어 8개 항목을 BLOCKED 로 보고했다.

| # | 미결 항목 | 본 문서 |
|---|---|---|
| 1 | "승인된 상품명"의 의미 | §2 |
| 2 | name-only 결과와 TC-INV-026 양립 | §2·§9·§14 |
| 3 | barcode 다중 후보 | §7 |
| 4 | name 다중 후보 | §8 |
| 5 | conflicting identifiers | §10 |
| 6 | resolver input/output exact contract | §5·§6 |
| 7 | REST endpoint 인지 internal service 인지 | §4 |
| 8 | current/effective period semantics | §11 |

본 결정으로 `T05-3 PRE-FLIGHT BLOCKED → T05-3 IMPLEMENTABLE` 로 전환한다.

### 최우선 호환성 원칙 — T05-2 계약 불변

T05-3 는 이미 확정·구현된 T05-2 계약을 **바꾸지 않는다.**

```text
MATCHED          = code 또는 barcode 를 가진 mapping
REVIEW_REQUIRED  = name-only mapping
UNMATCHED        = interactive CRUD 에서 생성 불가
MappingStatus enum = MATCHED · REVIEW_REQUIRED · UNMATCHED (3종 그대로)
```

⛔ name-only mapping 을 `MATCHED` 로 승격하지 않는다.
⛔ `MappingStatus` enum 을 확장하지 않는다.
⛔ T05-2 truth table 을 변경하지 않는다.

---

## 2. "승인된 상품명" supersede

원 우선순위 3단계의 **"승인된 상품명"**(`07:80`, `02:307`, `05:487`, `05_v0.2:125`)은
T05-3 V1 에서 **별도의 approval workflow / approval status 를 의미하지 않는다.**

repository 실측 — 다음이 **전부 없다.**

```text
SkuExternalMapping.approvalStatus / approvalRequestId / approvedBy / approvedAt
mapping approval API
mapping approval AuditLog action
```

없는 것을 새로 발명하지 않는다. V1 에서 3단계의 정확한 의미는:

> **현재 유효한 `SkuExternalMapping` 중 `externalProductName` 이 일치하는 매핑을
> 상품명 후보로 사용한다. 그러나 상품명만으로 찾은 결과는 절대로 자동 확정하지 않는다.**

단일 SKU 후보가 있어도 다음으로 반환한다.

```text
resolutionStatus = REVIEW_REQUIRED
matchedSkuId     = 후보 SKU ID
matchMethod      = NAME
autoApplicable   = false
requiresReview   = true
```

즉 **`matchedSkuId` 반환 자체는 허용**하되, downstream 이 자동 원장 반영에 쓸 수
있는 확정 매칭은 아니다. 이는 기존 원칙 —
`02:324`("`mapping_status = REVIEW_REQUIRED`(상품명 기반)는 **자동 반영 불가 플래그**"),
`02:479` ②("상품명 기반은 `REVIEW_REQUIRED`, **자동 원장 반영 불가**"),
`03:993`("REVIEW_REQUIRED(상품명 기반)는 자동 원장 반영 불가, 재고 PRD §20.5") —
을 authoritative 하게 구체화한 것이다.

명시적 External Mapping 승인 워크플로가 필요하면 **별도 미래 Task** 에서 설계한다.
**T05-3 에서 schema 를 추가하지 않는다.**

---

## 3. TC-INV-026 recovery

`TC-INV-026` 의 상세 Given/When/Then 원문이 repository 에 없다
(**`TC-INV-026 detailed contract missing`**). 본 결정에서 acceptance 를 고정한다.

| 사례 | 결과 |
|---|---|
| code unique | 자동 적용 **가능** (`MATCHED` / `CODE` / `autoApplicable=true`) |
| barcode unique | 자동 적용 **가능** (`MATCHED` / `BARCODE` / `autoApplicable=true`) |
| name-only unique | `matchedSkuId` 후보 반환 가능, **자동 적용 금지** (`REVIEW_REQUIRED`) |
| name ambiguous | 자동 적용 금지 (`AMBIGUOUS` / `NAME_AMBIGUOUS`) |
| no hit | `UNMATCHED` |
| code ↔ barcode conflict | 자동 적용 금지 (`CONFLICT` / `IDENTIFIER_CONFLICT`) |
| historical mapping | resolver 대상 **제외** |

**상품명만으로 자동 원장 반영하지 않는다** — 테스트로 고정한다.

---

## 4. REST 비노출 — internal application service

T05-3 V1 resolver 는 **internal application service** 로 구현한다.

⛔ 이번 Task 에서 만들지 않는다.

```text
POST /api/external-mappings/resolve   (라우트)
proxy permission policy
REST DTO
HTTP response contract
신규 RBAC permission
```

`05_v0.2:125` 의 `POST /api/external-mappings/resolve` 행(목적 "SKU 해석 **(내부)**",
권한 `—`, 멱등 `—`)은 T05-3 V1 에서 **superseded** 한다.
참고로 같은 문서는 REST 미노출 서비스를 `05_v0.2:286` 처럼
`*(내부)* | reservationService.reserve() | … | **R1 REST 미노출**` 형식으로도 적는다.

T17-2 등 application layer 가 resolver service 를 **직접 호출**한다.
explicit REST exposure 가 필요하면 미래 Task 에서 별도로 설계한다.

---

## 5. Input contract

```ts
interface ResolveExternalMappingInput {
  externalSystemId: string;
  externalProductCode?: string | null;
  externalBarcode?: string | null;
  externalProductName?: string | null;
}
```

- `externalSystemId` 는 **필수**다. 매핑의 uniqueness·scope 가 external system
  단위이므로 모든 조회는 같은 시스템 안에서만 한다 — 다른 시스템의 동일
  code/barcode/name 을 섞지 않는다.
- ⛔ `warehouseId` 는 **포함하지 않는다.** warehouse scope 를 새로 만들지 않는다
  (T08-1 전이며 T05-1/T05-2 에서도 API 입력이 아니다).
- 세 identifier 가 **전부 비어 있어도 오류가 아니다** — `UNMATCHED` 를 반환한다.
- 존재하지 않는(또는 UUID 형식이 아닌) `externalSystemId` 는 "매핑 없음"이 아니라
  **잘못된 호출**이므로 기존 ExternalSystem not-found convention(404 `NOT_FOUND`)에
  맞춰 명시적 application error 로 처리한다.

---

## 6. Output contract

T05-2 `MappingStatus` enum 과 resolver 결과를 **혼용하지 않는다.**
별도의 transient 결과 타입을 쓴다.

```ts
type ExternalMappingResolutionStatus =
  | 'MATCHED' | 'REVIEW_REQUIRED' | 'UNMATCHED' | 'AMBIGUOUS' | 'CONFLICT';

type ExternalMappingMatchMethod = 'CODE' | 'BARCODE' | 'NAME' | 'UNMATCHED';

type ExternalMappingResolutionReason =
  | 'CODE_MATCH' | 'BARCODE_MATCH' | 'NAME_ONLY_REVIEW_REQUIRED'
  | 'BARCODE_AMBIGUOUS' | 'NAME_AMBIGUOUS' | 'IDENTIFIER_CONFLICT'
  | 'NO_MATCH' | 'INVALID_BARCODE';

interface ResolveExternalMappingResult {
  resolutionStatus: ExternalMappingResolutionStatus;
  matchedSkuId: string | null;
  matchMethod: ExternalMappingMatchMethod;
  autoApplicable: boolean;
  requiresReview: boolean;
  candidateSkuIds: string[];
  reasonCode: ExternalMappingResolutionReason;
}
```

`candidateSkuIds` 는 항상 **distinct + 오름차순** 이다.
⛔ 새 DB enum·model·column 을 만들지 않는다.

### 확정 결과의 의미

| 상황 | status | matchedSkuId | matchMethod | auto | review | candidates | reason |
|---|---|---|---|:-:|:-:|---|---|
| code 단일 | `MATCHED` | SKU | `CODE` | ✅ | ❌ | `[sku]` | `CODE_MATCH` |
| barcode 단일 | `MATCHED` | SKU | `BARCODE` | ✅ | ❌ | `[sku]` | `BARCODE_MATCH` |
| name 단일 | `REVIEW_REQUIRED` | SKU | `NAME` | ❌ | ✅ | `[sku]` | `NAME_ONLY_REVIEW_REQUIRED` |
| 없음 | `UNMATCHED` | `null` | `UNMATCHED` | ❌ | ✅ | `[]` | `NO_MATCH` |

---

## 7. Code / Barcode matching rule

### 공통 조회 범위

```text
같은 externalSystemId
effectiveTo IS NULL          (현행 매핑만)
canonical 값 exact equality  (DB equality)
```

### code (1순위)

`ux_external_mapping_code` 때문에 현행 `(externalSystemId, externalProductCode)` 는
system 당 최대 1건이다. historical row 는 제외된다. code 는 가장 높은 신뢰도의
identifier 다.

### barcode (2순위)

`externalBarcode` 에는 **UNIQUE 제약이 없다**(T05-1 §7 에서 T05-3 로 이월된 항목).
따라서 반드시 candidate aggregation 을 한다.

> ★ **row count 가 아니라 distinct mapped SKU count** 로 모호성을 판단한다.
>
> - 같은 barcode 의 현행 row 가 2개지만 둘 다 SKU A → 후보 1개 → **단일 BARCODE match**
> - 같은 barcode 가 SKU A 와 SKU B 에 연결 → 후보 2개 → **AMBIGUOUS**

⛔ T05-3 에서 barcode unique index/migration 을 추가하지 않는다. 이월된 uniqueness
문제는 **resolver 가 안전하게 처리**하는 것으로 V1 을 확정한다.

### barcode 모호

```text
resolutionStatus = AMBIGUOUS
matchedSkuId     = null
matchMethod      = UNMATCHED
candidateSkuIds  = [distinct candidates...]
reasonCode       = BARCODE_AMBIGUOUS
```

⛔ 후보 중 하나를 임의 선택하지 않는다 — first row / latest row / smallest id 등
어떤 tie-break 도 금지다.
⛔ DataIssue·InventoryException 을 만들지 않는다 (§13).

---

## 8. Name matching rule

상품명 단계는 **상위 식별자가 아무 것도 확정하지 못했고 모호성으로 종료되지도
않았을 때만** 실행한다.

조회 범위는 code/barcode 와 동일(같은 system + `effectiveTo IS NULL` + exact equality).

⛔ **금지**: fuzzy · contains · startsWith · case-insensitive · similarity ·
levenshtein · trigram · AI/LLM matching.

> 근거: `01:374`("`#N/A` 152건은 **상품명 기반 VLOOKUP 실패**"),
> `00:214`("WMS 상품명 공란 **299/490(61%)** → 상품명 기반 자동 매핑은 실효성 낮음"),
> `01:385`("문자열 조인키 → 외부코드 기반 매핑으로 대체").

### name 모호

여러 row 여도 **distinct mapped SKU count** 로 판단한다.

- 1개 → `REVIEW_REQUIRED` + `matchedSkuId` 반환
- 2개 이상 →

```text
resolutionStatus = AMBIGUOUS
matchedSkuId     = null
matchMethod      = UNMATCHED
candidateSkuIds  = [distinct candidates...]
reasonCode       = NAME_AMBIGUOUS
```

---

## 9. Input canonicalization

T05-3 는 **새로운 문자열 정규화 정책을 만들지 않는다.** T05-2 CRUD 가 매핑
저장 시 쓰는 canonicalization 을 그대로 재사용한다.

| 대상 | 규칙 |
|---|---|
| code · name | trim → blank 면 없음. 내부 대소문자·앞자리 0·하이픈·공백 **보존** |
| barcode | T04-2 `normalizeBarcode` 를 통과한 값(공백·하이픈 제거, 숫자 전용) |

⛔ 새 규칙 추가 금지 — lowercase/uppercase 변환, case-insensitive 비교, fuzzy,
유사도 검색, 공백 collapse, punctuation 삭제, 한글/영문 normalization.

구현상 barcode canonicalization 은 **비throw 분류 함수 하나**(`classifyExternalBarcode`)로
공유하고, T05-2 의 `normalizeExternalBarcode` 는 "INVALID 면 던진다"만 얹은 얇은
wrapper 가 된다 — **T05-2 동작은 변경되지 않는다.**

### invalid barcode 입력

외부 데이터 수집 경로는 interactive CRUD API 와 다르다. 잘못된 바코드 하나 때문에
행 전체 해석을 예외로 중단하지 않는다.

```text
valid code + invalid barcode          → CODE MATCH
invalid barcode + valid single name   → REVIEW_REQUIRED / NAME
invalid barcode 만 있고 다른 match 없음 → UNMATCHED / INVALID_BARCODE
```

⛔ T04 interactive API 의 400/422 public error contract 를 여기로 가져오지 않는다.

---

## 10. 우선순위 · short-circuit · 충돌

### 알고리즘

```text
1  code candidate 조회
2  barcode candidate 조회
3  code ↔ barcode 정합성 판정
4  definitive result 가 있으면 종료
5  barcode ambiguity 가 있으면 종료
6  여기까지 미확정일 때만 name 조회
7  unique name  → REVIEW_REQUIRED
8  ambiguous name → AMBIGUOUS
9  모두 없음    → UNMATCHED
```

"priority" 는 **낮은 신뢰도의 결과가 높은 신뢰도의 결과를 덮어쓸 수 없다**는 뜻이다.
그러나 code 가 맞았다고 barcode 조회를 아예 건너뛰는 단순 SQL short-circuit 은
쓰지 않는다 — 그러면 `code → A, barcode → B` 라는 데이터 품질 문제를 **조용히 무시**하게 된다.

### code ↔ barcode

| Case | 입력 | 결과 |
|---|---|---|
| A | code → A, barcode → A | `MATCHED` / `CODE` / A (코드가 우선순위 상위) |
| B | code → A, barcode 없음 | `MATCHED` / `CODE` / A |
| C | code 없음, barcode → B | `MATCHED` / `BARCODE` / B |
| D | code → A, barcode → B | **`CONFLICT`** / `IDENTIFIER_CONFLICT` / candidates `[A,B]` |
| E | code → A, barcode → {A,B} | **`CONFLICT`** — barcode 후보가 A 외 다른 SKU 를 포함 |
| F | code 없음, barcode → {A,B} | **`AMBIGUOUS`** / `BARCODE_AMBIGUOUS`. name 으로 fallback 하지 않는다 |

### name 은 상위 식별자와 충돌 판정하지 않는다

name 은 low-confidence / review-required identifier 다. code 또는 barcode 가
`MATCHED` 로 확정된 상태에서 상품명이 다른 SKU 후보를 가리켜도 **CONFLICT 로 바꾸지 않는다.**

```text
CODE / BARCODE  = definitive identifiers
NAME            = fallback review candidate
```

상품명은 code/barcode 를 override 하지 않는다.

---

## 11. Current / effective period semantics

V1 의 **"current mapping"** 정의는 T05-1 partial unique predicate 와 동일하다.

```text
effectiveTo IS NULL
```

`effectiveTo IS NOT NULL` (historical) 은 resolver 대상에서 **제외**한다.

⛔ V1 에 없는 것: `asOf` input · historical lookup · `effectiveFrom` 기반 future
scheduling. `effectiveFrom` 이 있어도 새 활성화 시점 로직을 발명하지 않는다.
시간 기준 resolution 은 별도 미래 version 에서 설계한다.

---

## 12. SKU eligibility boundary

resolver 는 **identity resolution 만** 담당한다. 매핑이 가리키는 SKU 의
`ACTIVE`/`INACTIVE`/`DISCONTINUED`/`ARCHIVED`/`deletedAt` 상태를 근거로 결과를
임의로 제거하지 않는다.

근거: T05-2 매핑 생성에도 SKU status 제한이 없다(`docs/13` §5). resolver 가 새
restriction 을 발명하지 않는다. `matchedSkuId` 는 매핑 레코드가 가리키는 identity
그대로다. 실제 posting/reconciliation/transaction eligibility 는 **downstream
application service 의 책임**이다.

---

## 13. Side effects — pure read

resolver 는 **순수 조회 서비스**다. 절대 하지 않는다.

```text
SkuExternalMapping INSERT/UPDATE     SKU UPDATE
AuditLog 생성                         DataIssue 생성
InventoryException 생성               InventoryReconciliation 생성
ExternalInventorySnapshotLine UPDATE  InventoryBalance UPDATE
Posting Service 호출
```

특히 미매칭/모호/충돌 **예외를 영속화하는 책임은 T05-3 에 없다** —
T17-2 에서 snapshot/reconciliation pipeline 과 함께 결정한다.

멱등 인프라도 없다 — `Idempotency-Key` · `IdempotencyRecord` · `requestHash` 전부
read-only 서비스에는 해당하지 않는다.

---

## 14. T17-2 boundary

T17-2 는 `ExternalInventorySnapshotLine` 의 `matchedSkuId`(nullable) 와
`matchMethod`(`CODE / BARCODE / NAME / UNMATCHED`)에 결과를 저장할 예정이다.

- resolver 의 `matchMethod` 도 **정확히 그 4종**으로 고정한다.
- ⛔ `AMBIGUOUS` · `CONFLICT` 문자열을 DB `matchMethod` 값으로 추가하지 않는다.
  그 둘은 transient `resolutionStatus` 로만 표현하며, persistence 또는 exception
  표현 방법은 **T17-1/T17-2 설계에서 별도 결정**한다.
- T05-3 때문에 snapshot schema 를 변경하지 않는다.

---

## 15. resolveOne / resolveMany

internal service 는 둘 다 제공한다.

```ts
resolveOne(input)
resolveMany(inputs)
```

- 두 함수의 결과 semantics 는 **완전히 동일**하다 — `resolveOne` 은 실제로
  `resolveMany([input])[0]` 을 그대로 쓴다(구현이 갈라질 여지를 만들지 않는다).
- `resolveMany` 는 N 회 `resolveOne` DB 조회를 반복하는 **N+1 구현을 금지**한다.
  `(externalSystemId, code, barcode, name)` lookup key 를 dedupe 한 뒤 **bulk
  조회 1회씩**만 하고 메모리에서 각 입력의 결과를 조합한다.
  쿼리 수는 입력 수와 무관하게 **시스템 1 + 코드 1 + 바코드 1 + 상품명 1 (최대 4)** 이다.
- 반환 배열은 **입력 순서와 1:1** 이다.

⛔ T17 snapshot/upload/reconciliation 자체는 구현하지 않는다. T17-2 의 500행
파이프라인을 선구현하지 않는다 — resolver 의 batch capability 까지만 T05-3 범위다.

### 결정성

같은 DB state + 같은 canonical input 이면 **항상 동일 결과**여야 한다.
`candidateSkuIds` 는 distinct + 오름차순 정렬이며 DB 반환 순서에 좌우되지 않는다.

---

## 16. Module structure · schema

```text
External Mapping Application Service  (resolve-mapping.ts)
    ↓
Resolver 판정 로직 (순수 함수)
    ↓
Repository/Prisma 포트 (resolver-port.ts)
```

라우트를 추가하지 않는다. business matching logic 을 Prisma adapter 나 route 에
직접 넣지 않는다. 기존 T05-1/T05-2 코드를 대규모 이동/refactor 하지 않는다 —
공유가 필요한 normalization helper 만 최소 범위로 추출했다.

### schema / migration

T05-3 에서 **전부 금지**이며 실제로 변경하지 않았다.

```text
Prisma schema 변경 · migration 추가 · MappingStatus 변경
barcode unique index 추가 · approval column 추가
snapshot schema 변경 · DataIssue schema 추가
```

---

## 17. V1 범위 밖 (미구현 고정)

```text
External Mapping approval workflow / approvalRequest / approvedBy / approvedAt
MappingStatus enum 확장 · T05-2 truth table 변경
REST resolve endpoint · 신규 RBAC permission
DataIssue · InventoryException 생성
T17 snapshot upload · reconciliation · posting · inventory balance update
T17 schema 변경 · fuzzy name matching · barcode unique migration
External Mapping UI · asynchronous worker
```

---

## 부록 — 확정 계약 요약

| # | 항목 | 확정 |
|---|---|---|
| 1 | 노출 형태 | internal application service. REST 라우트·권한 없음 |
| 2 | "승인된 상품명" | 별도 승인 워크플로 아님 — name 일치 매핑을 **후보로만** 사용 |
| 3 | T05-2 계약 | 불변 (MappingStatus 3종, truth table 그대로) |
| 4 | input | `externalSystemId`(필수) + code/barcode/name(선택). `warehouseId` 없음 |
| 5 | 식별자 전무 | 오류 아님 → `UNMATCHED` |
| 6 | 없는 systemId | 404 `NOT_FOUND` (잘못된 호출) |
| 7 | current | `effectiveTo IS NULL`. historical 제외, `asOf` 없음 |
| 8 | code | system 내 exact, 최대 1건 (partial unique) |
| 9 | barcode | system 내 exact. **distinct SKU 수**로 모호성 판정 |
| 10 | name | system 내 exact only. fuzzy 일체 금지 |
| 11 | code↔barcode 충돌 | `CONFLICT` / `IDENTIFIER_CONFLICT`. 임의 선택 없음 |
| 12 | name 충돌 | 상위 식별자를 override 하지 않는다 |
| 13 | invalid barcode | 예외 아님 — 해당 단계만 조회 불가 |
| 14 | SKU 상태 | 필터링하지 않는다 (downstream 책임) |
| 15 | side effects | **0건** (pure read) |
| 16 | matchMethod | `CODE/BARCODE/NAME/UNMATCHED` 4종 고정 (T17-1 호환) |
| 17 | batch | `resolveMany` 는 상수 쿼리 수. 결과는 `resolveOne` 과 동일 |
| 18 | schema | **변경 없음** |
