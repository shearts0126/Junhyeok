# 설계복구 — SKU 상세 잔여 탭 (T1-6B) · 바코드 탭 (T1-6B1) · 외부매핑 탭 (T1-6B2) · 변경이력 탭 (T1-6B3)

> **2026-08-11 SKU Detail Remaining Tabs Design Recovery Decision**
>
> 이 문서는 T1-6B 분할과 **T1-6B1·T1-6B2·T1-6B3 구현 계약의 유일한 근거**다.
> 여기에 없는 규칙을 코드에서 추론해 만들지 않는다.
>
> §1~§18 = T1-6B1(바코드 탭 + T04-4B) · §19~§26 = T1-6B2(외부시스템 매핑 탭) ·
> **§27~§40 = T1-6B3(변경이력 탭 + 지원 read API)**

---

## 1. 배경 — `T1-6B` 는 backlog task ID 가 아니다

authoritative backlog 의 실제 항목은 **한 줄**이다.

| 문서 | 항목 | 선행조건 |
|---|---|---|
| `07_개발백로그와_테스트전략.md:60` | **T03-6** SKU 상세 화면 8탭 | T03-4 |
| `07_개발백로그와_테스트전략_v0.2.md:108` | **T1-14** SKU 상세 화면 8탭 + 코드 추천 | T1-4, **T1-7**(바코드), **T1-9**(매핑) |

`T1-6A` / `T1-6B` 는 이 한 항목을 세션에서 나눈 **작업 라벨**이며 backlog 에 없다.
이 문서가 그 분할을 정식으로 기록한다. ⛔ backlog 원문을 고쳐 쓰지 않는다.

### 원 설계 자체에 있던 긴장

v0.2 는 SKU 상세 화면(`T1-14`)을 **R1a-1** 에 두면서 선행조건에서 공급조건·BOM 을
제외했고, `Supplier`(`T3-1`~)·`BOM`(`T3-5`~)은 **R1a-3** 에 두었다. 즉 "8탭 화면을
공급조건·BOM backend 없이 R1a-1 에서 만든다"는 모순이 원문에 이미 있었다.
**단계적 구현이 원 설계의 의도**이며, 아래 분할은 그것을 명시화한 것이다.

---

## 2. T1-6B 분할 (B1~B5)

| Task | 탭 | 판정 | 근거 |
|---|---|---|---|
| **T1-6B1** | **③ 바코드** (+ **T04-4B** 흡수) | **§1~§18 로 IMPLEMENTABLE** | T04-3·T04-4A backend 100% |
| **T1-6B2** | **④ 외부시스템 매핑** | **§19~§26 로 IMPLEMENTABLE** | 신규 API 0. 역할 분담(read-only + 관리화면 링크)·창고 제외를 §19·§21 로 확정 |
| **T1-6B3** | ⑧ 변경이력 | **DEFERRED** | `GET /api/skus/{id}/history` 미구현 + 범위 미결(`docs/10:314`) |
| **T1-6B4** | ⑥ 공급조건 | **BLOCKED** | `Supplier`/`SupplierSku`/`SupplierSkuPrice` 전무 → **T06** 이후 |
| **T1-6B5** | ⑦ BOM | **BLOCKED** | `BomHeader`/`BomLine` 전무 → **T07** 이후 |

T1-6B 전체 COMPLETE 판정은 B5 까지 끝난 뒤에 한다 → 현재 **PARTIAL**.

---

## 3. T1-6B1 exact scope

**포함**

- `/master/skus/{id}` 에 ③ 바코드 탭 추가
- 등록/상세 탭 배열 분리 (`/master/skus/new` 는 기존 3탭 유지)
- 바코드 목록·등록·대표 지정/해제·비활성·재활성
- **T04-4B**: 409 사후 중복 경고 → 명시적 중복 예외 요청 → `PENDING_DUPLICATE` 표시
  → 요청 취소 → 중복 예외 승인(사유 필수) → 승인 결과 표시
- permission 기반 child tab visibility

**제외 (이번 범위 아님)**

외부매핑 탭 · 변경이력 탭 · 공급조건 탭 · BOM 탭 · `/master/skus/approvals` ·
cross-SKU 승인 대기함 · 중복 사전조회 API · 사용자 조회 API · 감사로그 조회 API ·
archive · `sku.archive` · `hasBomUsage` · 활성 BOM 비활성 경고 · V7~V9 wiring ·
국가/채널/적용기간 write · schema 변경 · migration.

---

## 4. T04-4B 흡수

`docs/11_설계복구_Barcode중복예외승인.md` §27 이 "T04-4B 는 T1-6B Barcode 탭 구현 시
합쳐 진행한다"로 이미 지정했다. 이 문서가 그 계약을 확정한다.

**T04-4B 의 유일한 진입점은 SKU 상세 바코드 탭**이다.
`05 §11.5` 의 SKU 승인 대기함(`/master/skus/approvals`) 버튼은 **cross-SKU 승인함**
이며 T1-4B 소관이다 — 이번 범위에서 만들지 않는다.

T1-6B1 acceptance(§17)가 충족되면 **T04-4 = COMPLETE** 로 전환한다.

---

## 5. 신규 backend 0개

기존 6개 endpoint 만 쓴다. **T04-3 / T04-4A production semantics 를 바꾸지 않는다.**

```
GET    /api/skus/{id}/barcodes                          barcode.read
POST   /api/skus/{id}/barcodes                          barcode.create
PATCH  /api/skus/{id}/barcodes/{bid}                    barcode.update
DELETE /api/skus/{id}/barcodes/{bid}                    barcode.deactivate
POST   /api/skus/{id}/barcodes/duplicate-candidates     barcode.request_duplicate
POST   /api/skus/{id}/barcodes/{bid}/approve-duplicate  barcode.approve_duplicate
```

⛔ 새 route·permission·schema·migration 을 만들지 않는다.

---

## 6. 목록 표시

`SkuBarcodeView` 전 필드를 그대로 쓴다. status 는 `ACTIVE`·`INACTIVE`·
`PENDING_DUPLICATE` **셋 다** 표시한다(GET 이 전부 반환한다, `docs/11` §25).

| 열 | 비고 |
|---|---|
| 바코드 · 타입 · 대표 | |
| **국가 · 채널 · 적용기간** | **조회 전용** (§8) |
| 상태 | 배지 |
| 중복예외 | 승인된 예외만 배지 + 사유 |
| 작업 | §11·§13 액션 매트릭스 |

`null` 은 `0`·공란이 아니라 항상 **`—`** 다.

---

## 7. 등록/상세 탭 분리 · 순서

바코드는 `/api/skus/{id}/barcodes` 처럼 경로에 부모 `skuId` 를 요구하는 child entity
라 **저장 전에는 존재할 수 없다.**

```
/master/skus/new       기본정보 · 코드·분류 · 재고관리 설정                  (3탭, 기존 그대로)
/master/skus/{id}      기본정보 · 코드·분류 · **바코드** · 재고관리 설정      (4탭)
```

> ✏️ **T1-6B2 이후**: 상세는 ④ 외부시스템 매핑이 더해져 **5탭**이 된다 (§19).
> 등록 화면 3탭과 "child entity 탭은 저장된 SKU 에서만" 원칙은 그대로다.

- 탭 배열을 `SKU_CREATE_TABS` / `SKU_DETAIL_TABS` 로 **분리**한다.
- ⛔ 등록 화면에 바코드 탭을 disabled·placeholder 로도 두지 않는다 (T1-6A 계약 유지).
- ★ 등록 성공 시 이미 상세로 이동하므로 사용자는 바로 바코드를 등록할 수 있다.
- ★ **순서는 원문 8탭(`05 §11.4`)의 논리 순서**(① ② ③ ⑤)를 그대로 따른다.
  구현된 탭만 남기되 재배열하지 않는다 — 이후 ④·⑥·⑦·⑧ 이 제자리에 들어온다.

---

## 8. 국가 · 채널 · 적용기간은 조회 전용

`05 §11.4 ③` 은 이 4개 필드를 탭 항목으로 요구하지만, T04-3 V1 DTO 는 이들을
**입력받지 않는다**(`strictObject` → 400).

| 필드 | GET | POST | PATCH |
|---|:-:|:-:|:-:|
| `countryCode` · `channelCode` · `effectiveFrom` · `effectiveTo` | ✅ | ❌ | ❌ |

→ **표시만** 하고 등록/수정 폼에 넣지 않는다.
⛔ UI 를 맞추려고 T04-3 API 를 확장하지 않는다 — 별도 Task 의 몫이다.
화면에 "현재 API 가 입력을 받지 않아 조회 전용"임을 명시한다.

---

## 9. 중복 감지 UX — **409 사후 방식**

⛔ 중복 사전조회 API 를 만들지 않는다. 다른 SKU 의 바코드 존재를 노출하는 새
정보공개 결정이 필요하고(바코드 404 정책은 정확히 그 반대다) 근거도 없다.

```
① 일반 등록 POST
② 409 BARCODE_DUPLICATE
③ dialog 를 닫지 않는다
④ 입력값을 그대로 유지한다
⑤ 인라인 경고를 붙인다
⑥ `barcode.request_duplicate` 가 있으면 `중복 예외 요청` CTA 를 노출한다
```

경고 문구:

> 동일한 활성 바코드가 다른 SKU 에서 사용 중입니다. 필요한 경우 중복 예외 요청을
> 등록할 수 있습니다.

⛔ **다른 SKU 정보를 표시하지 않는다** — API 가 주지 않는다.

### ★ 409 라고 다 중복이 아니다

CTA·경고는 **`BARCODE_DUPLICATE` 에만** 붙인다.
`BARCODE_PRIMARY_CONFLICT` · `BARCODE_DUPLICATE_CANDIDATE_EXISTS` ·
`IDEMPOTENCY_KEY_REUSED` 도 409 지만 중복 예외 대상이 **아니다** — 여기에 CTA 를
띄우면 사용자를 잘못된 mutation 으로 유도한다.

---

## 10. 중복 예외 요청 — 자동 생성 금지

**사용자가 `중복 예외 요청` 을 명시적으로 클릭해야만** 후보가 만들어진다.
⛔ 409 를 받았다고 자동으로 candidate 를 생성하지 않는다 — 바코드 공유는 의도적
결정이며, 서버도 그래서 endpoint 를 분리했다(`docs/11` §2).

- 후보 body 는 **일반 등록의 raw 입력 그대로** `{barcode, barcodeType, isPrimary?}` 다.
  `requestDuplicateCandidateSchema === createBarcodeSchema` 이므로 값을 바꾸지 않는다.
- 등록 시도와 후보 요청은 **서로 다른 논리적 mutation** 이다 → **별도 `Idempotency-Key`**
  lifecycle 을 쓴다(등록 시도의 key 를 재사용하지 않는다).
- 성공 후 refetch. **201**(신규)·**200**(기존 후보·replay) 모두 "요청 등록됨"으로 다룬다.
- ⛔ 자동 승인 없음.

---

## 11. `PENDING_DUPLICATE` · 승인

배지: **`중복 예외 승인 대기`**

가능한 액션은 **정확히 둘** 뿐이다.

| 액션 | 호출 | permission |
|---|---|---|
| `중복 예외 승인` | `POST .../approve-duplicate` | `barcode.approve_duplicate` |
| `요청 취소` | `DELETE .../{bid}` → `INACTIVE` | `barcode.deactivate` |

⛔ 일반 수정(대표 지정·재활성·비활성) 액션을 노출하지 않는다 — 서버가 422
`BARCODE_DUPLICATE_APPROVAL_PENDING` 로 막는 경로다(`docs/11` §23).
⛔ 물리삭제 없음 — 취소는 `INACTIVE` 다(`docs/11` §24).

### 승인 dialog

표시: 바코드 · 타입 · 현재 SKU 코드 · 안내문 · **사유 textarea**.

- `reason` **필수**. client 에서도 trim 후 비어 있으면 제출을 막는다(서버도 400).
- 전송 body 는 **`{reason}` 뿐**. ⛔ 새 최대 길이를 만들지 않는다(`docs/11` §13).
- 성공 후 refetch → `ACTIVE` + `중복 예외` 배지 + 사유 표시.

### 승인 결과 메타 — 무엇을 보이고 무엇을 감추는가

| 항목 | 표시 | 근거 |
|---|:-:|---|
| `duplicateException` | ✅ 배지 | GET 포함 |
| `exceptionReason` | ✅ | GET 포함 |
| `approvedBy` | ❌ | **UUID 뿐** — 사용자 조회 API 가 없다 |
| 승인 시각 | ❌ | `approvedAt` 컬럼 없음, 감사로그 조회 API 없음 |

⛔ 이 표시를 위해 user lookup API·audit read API 를 만들지 않는다.

---

## 12. 권한 기반 child tab visibility

`barcode.read` 가 없으면 **바코드 탭 자체를 노출하지 않는다.**

근거: `05 §11.20` 이 `SKU 목록·상세 = E:R` 이면서 `외부 상품 매핑 = E:—` 로 두어,
**SKU 상세를 볼 수 있다고 모든 하위 모듈을 볼 수 있는 것이 아님**을 이미 규정한다.
바코드는 `barcode.read` 가 5역할 전부라 현재는 충돌이 없지만, 판정 기준은 동일하다.

- 판정은 **`/api/me.permissions` 문자열 포함 여부**로만 한다. ⛔ 역할 이름 하드코딩 금지.
- ⛔ ADMIN bypass 없음 — 서버는 `RolePermission` 데이터로만 판정한다.
- 탭을 감추는 것은 **미노출**이지 위장이 아니다. 권한이 있는데 서버가 403 을 주면
  탭 안에서 그대로 보여준다(`403 을 빈 목록으로 위장하지 않는다` 는 기존 계약 유지).

### mutation 별 permission

| UI control | permission |
|---|---|
| 바코드 추가 | `barcode.create` |
| 대표 지정/해제 · 재활성 | `barcode.update` |
| 비활성 · 요청 취소 | `barcode.deactivate` |
| 중복 예외 요청 | `barcode.request_duplicate` |
| 중복 예외 승인 | `barcode.approve_duplicate` |

`barcode.approve_duplicate` 는 **ADMIN·SCM_LEADER** 뿐이다. SCM_STAFF 는 등록·요청은
되지만 승인 control 이 **없다**.

⛔ 자가승인 차단 UI 를 만들지 않는다 — 바코드에는 자가승인 금지 정책이 없다
(`docs/11` §12). 자신이 만든 후보를 직접 승인하는 것도 허용된 현재 계약이다.

---

## 13. ACTIVE / INACTIVE 액션

| status | 액션 | 호출 |
|---|---|---|
| `ACTIVE` | 대표 지정/해제 | `PATCH {isPrimary}` |
| `ACTIVE` | 비활성 | `DELETE` → `INACTIVE` |
| `INACTIVE` | 재활성 | `PATCH {status:'ACTIVE'}` |

- ⛔ 다른 행의 대표를 **자동 해제하지 않는다** — 충돌은 서버 409
  `BARCODE_PRIMARY_CONFLICT` 를 그대로 보여준다.
- 재활성 충돌(409 `BARCODE_DUPLICATE`)도 그대로 보여준다.
  ⛔ 재활성 실패를 자동으로 중복 예외 후보 생성으로 바꾸지 않는다.
- 승인된 중복 예외 행도 `ACTIVE` 이므로 위 액션이 그대로 적용된다.

---

## 14. Revoke 는 없다

repository 전체에 `revoke`·`철회`·`승인 취소`·`예외 해제` 계약이 **0건**이다.
V1 에서 다음을 **구현하지 않는다.**

```
duplicate approval revoke · duplicateException true→false ·
exceptionReason clear · approvedBy clear
```

기술적 이유도 있다 — `true → false` 로 되돌리는 순간 그 행이 `ux_barcode_active`
predicate 안으로 들어가, 같은 바코드의 `ACTIVE + false` 행이 있으면 P2002 가 난다.
안전한 revoke 는 새 오류 계약을 요구한다.

⚠️ **혼동 금지**: 승인된 중복 예외 바코드를 일반 `DELETE` 로 `INACTIVE` 처리하는 것은
가능하며 그것은 **revoke 가 아니다**(`duplicateException` 은 true 로 남고 predicate
밖이라 무해하다).

---

## 15. `204 No Content` 는 성공 표시가 아니다

`-`·공란 등 미입력 표시값은 서버가 **204** 로 응답하며 **행을 만들지 않는다**
(`docs/10` §8). UI 는 이것을 "등록 성공"으로 위장하지 않고, 저장되지 않았음을
알리고 dialog 를 유지한다.

---

## 16. Idempotency

일반 등록은 T1-6A `/new` 와 같은 **논리적 시도 1개당 key 1개** 정책이다 —
입력 내용이 바뀌면 새 key, 같은 내용의 재시도는 같은 key.
중복 예외 요청은 **별개의 mutation** 이므로 새 key 를 쓴다.

승인 endpoint 는 멱등 인프라가 없다(`docs/11` 부록) — 재호출 안전성은 서버의
상태 semantics(이미 승인된 행이면 200 no-op)가 담당한다.

---

## 17. 인수조건 (T1-6B1)

| # | 조건 | 분류 |
|---|---|---|
| 1 | 상세 4탭(바코드 포함) · 등록 3탭 · 원문 순서 유지 | confirmed |
| 2 | `barcode.read` 없으면 바코드 탭 미노출 | confirmed |
| 3 | 목록이 ACTIVE·INACTIVE·PENDING_DUPLICATE 를 모두 보여준다 | confirmed |
| 4 | 일반 등록 성공 → ACTIVE 행 | confirmed |
| 5 | 중복 등록 → 409 경고 + 입력값 유지 + **행 생성 0** | confirmed |
| 6 | 명시적 클릭으로만 중복 예외 요청 | confirmed |
| 7 | `PENDING_DUPLICATE` 배지 + 승인·취소 액션만 | confirmed |
| 8 | 승인 사유 필수 · trim | confirmed |
| 9 | 승인 후 ACTIVE + `중복 예외` 배지 + 사유 표시 | confirmed |
| 10 | SCM_STAFF 에게 승인 control 없음 | confirmed |
| 11 | 요청 취소 → INACTIVE (물리삭제 아님) | confirmed |
| 12 | revoke UI 없음 | confirmed |
| 13 | 승인자·승인시각 미표시 | 이 문서로 확정 |
| 14 | 국가·채널·적용기간 조회 전용 | 이 문서로 확정 |
| 15 | `/new` 에 바코드 탭 없음 | 이 문서로 확정 |

---

## 18. 범위 밖 재확인

`V7`(`BARCODE_SCIENTIFIC_NOTATION`) · `V8`(`BARCODE_UNVERIFIED`) ·
`V9`(`BARCODE_DUPLICATE`)는 계속 **`NOT_APPLICABLE`** 이며 `approval-validation.ts`
를 이번 범위에서 변경하지 않는다. V9 wiring 은 **T1-4B** 다(`docs/11` §28).

`T05-4A`(`EXT-MAP-001`) 계약도 변경하지 않는다. `T05-4B`(미매칭·일괄·import)는
T15/T17 선행 미비로 DEFERRED 유지다.

---
---

# T1-6B2 — 외부시스템 매핑 탭 (2026-08-11 추가 확정)

> §19~§26 은 **T1-6B2 구현 계약**이다. §1~§18(T1-6B1)의 결정은 그대로 유효하다.

---

## 19. B2 scope — read-only summary 뿐

SKU 상세 `/master/skus/{id}` 에 **④ 외부시스템 매핑** 탭을 추가한다.
이 탭이 하는 일은 정확히 셋이다.

```
① 해당 SKU 의 외부 매핑 조회   ② 매핑상태 요약   ③ EXT-MAP-001 로 이동
```

**포함**: 목록 표시 · 상태 배지 · 종료 표시 · 로컬 페이지 이동 · 관리 화면 링크.

**제외 (embedded CRUD 금지)**: 신규 매핑 dialog · 수정 dialog · 매핑 해제 ·
외부시스템 selector · SKU selector · identifier editor · 대표 토글 ·
`effectiveTo` mutation. **모든 변경은 `/master/external-mappings` 에서 한다.**

### 탭 순서

```
① 기본정보  ② 코드·분류  ③ 바코드  ④ 외부시스템 매핑  ⑤ 재고관리 설정
```

원문 8탭(`05 §11.4`)의 논리 순서를 그대로 유지한다. `/master/skus/new` 는 계속
**3탭**이며, 외부매핑 탭을 추가·disabled·placeholder 어떤 형태로도 두지 않는다
(§7 의 child entity 원칙과 같다 — 부모 SKU 가 저장돼야 존재할 수 있다).

---

## 20. 신규 API 0개 — 쿼리 계약

기존 `GET /api/external-mappings` 하나만 쓴다. T05-2/T05-4A 계약을 바꾸지 않는다.

```
GET /api/external-mappings?skuId={skuId}&page={n}&pageSize=50
```

이 탭이 보내는 파라미터는 **정확히 이 3개뿐**이다.

⛔ `q` · `externalSystemId` · `mappingStatus` · `sort` · `warehouseId` 를 보내지 않는다.
⛔ **URL searchParams 와 연동하지 않는다** — 관리 화면(`EXT-MAP-001`)의 URL-state
   아키텍처를 SKU 상세로 가져오지 않는다. SKU 상세의 활성 탭도 기존대로 local
   state 다.

### 페이지네이션 (V1)

`pageSize` 는 **50 고정**(UI 선택지 없음)이고 페이지는 **탭 내부 local state** 다.
`totalPages > 1` 일 때만 이전/다음 버튼을 노출하며, 전체 조회는 관리 화면 링크로도
가능하다. 한 번에 전부 가져온다고 가정하지 않는다.

---

## 21. 표시 — T05-4A convention 재사용

| 열 | 비고 |
|---|---|
| 외부시스템 | `systemCode — systemName` (joined projection) |
| 외부코드 · 외부상품명 | `null` 은 빈 문자열 (관리 화면과 같은 표현) |
| 매핑상태 | `MATCHED` · `REVIEW_REQUIRED` · `UNMATCHED` 배지 |
| 대표 | `대표` / 공란 |
| 적용기간 | `formatEffectivePeriod` 그대로. 종료 행은 `종료됨` 병기 |

- **창고 열이 없다.** `05 §11.4 ④` 원문의 `창고` 는 `Warehouse`(T08-1) 이후다 —
  ⛔ placeholder · `—` 열 · fake 값 · lookup · API · schema 어느 것도 만들지 않는다.
- **종료된 매핑을 숨기지 않는다.** GET 이 이력을 반환하므로 그대로 보여준다.
- **SKU 열을 반복하지 않는다.** 현재 SKU 상세 안이라 자명하다.
- 상태 배지 색·`REVIEW_REQUIRED` 안내문은 관리 화면과 **같은 상수**를 쓴다
  (display helper 최소 공유 — 동작 변경 없음).
- ⛔ `AMBIGUOUS` · `CONFLICT` 는 resolver(T05-3)의 transient 판정이지
  `SkuExternalMapping.mappingStatus` 가 아니다 — 탭 상태로 넣지 않는다.
- ⛔ 비활성 외부시스템에 새로운 제한·경고를 추가하지 않는다 (T05-4A semantics 유지).

### `REVIEW_REQUIRED`

의미는 T05-4A 와 동일하다 — **상품명 기반 매핑이며 자동 원장 반영 대상이 아니다.**
탭에서는 상태로 드러내되 ⛔ edit · approve · confirm · resolver action 을 제공하지
않는다. 해소는 관리 화면에서 한다.

### 외부 상품명 고지

`05 §11.4 ④` 의 "외부 상품명이 표준 상품명을 덮어쓰지 않음을 UI로 명시" 를 문구로 넣는다.

> 외부 상품명은 외부시스템 식별용 정보이며 SKU 표준 상품명을 변경하지 않습니다.

---

## 22. 관리 화면 링크

```
/master/external-mappings?skuId={skuId}
```

T05-4A 의 URL-state 계약(`skuId` 는 관리 키다)을 그대로 이용해 **해당 SKU 로
필터된 상태**로 진입한다.

⛔ SKU 코드·상품명 등 다른 파라미터를 붙이지 않는다 — 관리 화면이 모르는 키는
보존돼 API 400 이 되므로 아는 키 하나만 넘긴다.

탭 자체가 `external_mapping.read` 일 때만 보이므로 이 링크에 별도 권한 검사를 두지
않는다. 신규·수정·매핑 해제 버튼의 노출은 관리 화면의 기존 계약이 담당한다 —
⛔ SKU 상세 탭에서 create/update 권한을 다시 판단해 CRUD 버튼을 만들지 않는다.
빈 목록에서도 링크는 남지만 mutation CTA 처럼 표현하지 않는다.

---

## 23. 상태 표시 — loading / empty / 오류

| 상황 | 표시 |
|---|---|
| loading | "외부 매핑을 불러오는 중…" |
| 0건 | **"등록된 외부시스템 매핑이 없습니다."** |
| 403 | 전용 문구. ⛔ 빈 목록으로 위장하지 않는다 |
| 400 · 404 · 500 · 네트워크 | `readApiError` → `ErrorBanner` (기존 패턴) |

---

## 24. 권한 — child tab visibility

`external_mapping.read` 가 있을 때만 탭을 노출한다. 판정은
**`/api/me.permissions` 문자열 포함 여부**로만 한다(⛔ 역할 이름 하드코딩, ⛔ ADMIN bypass).

★ **EXECUTIVE 가 실제 경계 사례다** — `sku.read` 는 있고 `external_mapping.read` 는
없다(`05 §11.20`: `SKU 목록·상세 = E:R`, `외부 상품 매핑 = E:—`). 따라서 SKU 상세는
열리지만 외부매핑 탭은 보이지 않는다. 같은 사용자에게 **바코드 탭은 보인다**
(`barcode.read` 는 5역할 전부) — 두 child 탭의 노출이 서로 다르다.

권한 없는 사용자에게 `/api/external-mappings` 를 **호출하지 않는다** — 자식
컴포넌트는 해당 탭이 활성일 때만 마운트되고, fetch 도 그 안에서만 한다.
권한이 사라져 현재 탭이 유효하지 않게 되면 §12 와 같이 `기본정보` 로 되돌린다.

---

## 25. 컴포넌트 경계 — T05-4A 를 재구성하지 않는다

`ExternalMappingsClient` 를 통째로 embed 하지 않는다. 그 컴포넌트는 page URL
searchParams 에 결합되어 있고 q/filter/page 상태와 관리 CRUD 를 함께 갖는다.
SKU 상세에는 **별도의 lightweight read-only 컴포넌트**를 둔다.

⛔ 이번 Task 를 이유로 `ExternalMappingsClient` 대규모 refactor · form component
재구성 · URL-state helper 변경 · 관리 페이지 구조 변경을 하지 않는다.
허용되는 것은 **display helper 최소 추출**(상태 배지 색 · `REVIEW_REQUIRED` 문구)
뿐이며 기존 T05-4A E2E·계약을 깨지 않는다.

---

## 26. 남은 범위

| Task | 탭 | 상태 |
|---|---|---|
| **T1-6B3** | ⑧ 변경이력 | **DEFERRED** — `GET /api/skus/{id}/history` 미구현 + 범위 미결(`docs/10:314`) |
| **T1-6B4** | ⑥ 공급조건 | **BLOCKED** — T06 이후 |
| **T1-6B5** | ⑦ BOM | **BLOCKED** — T07 이후 |

이번 범위에서 만들지 않는다: `/unmatched` · 일괄 매핑 · import(T05-4B) ·
resolver REST · warehouse(T08) · DataIssue · InventoryException · T15 · T17 ·
History 탭/API · Supplier · BOM · `/master/skus/approvals` · V7~V9 wiring.
schema · migration · 신규 API · 신규 permission · route policy 변경 **모두 0** 이다.

---

# T1-6B3 — ⑧ 변경이력 탭 + `GET /api/skus/{id}/history`

> **2026-08-11 SKU 변경이력 Design Recovery Decision (D-1 ~ D-17)**
>
> §26 의 `T1-6B3 = DEFERRED` 행은 **이 절(§27~§40)로 해제된다** — 원문은 당시
> 판단의 역사 기록으로 그대로 둔다.

## 27. PRE-FLIGHT 결과 — 왜 BLOCKED 였나

T1-6B3 PRE-FLIGHT 는 `BLOCKED — DESIGN RECOVERY REQUIRED` 였다. 원문 근거는
`05 §10.3` 의 **한 줄**과 `05 §11.4` ⑧ 행의 **두 칸**뿐이다.

| 원문 | 내용 | 미결 |
|---|---|---|
| `05 §10.3` | `GET /api/skus/{id}/history` · 요청 `page` · 응답 `AuditLog[]` · 권한 **"전체"** | 응답이 배열인지 envelope 인지 · `pageSize` · 정렬 · **"전체" = 어떤 permission** · 어느 entity 까지 |
| `05 §11.4` ⑧ | `감사로그 타임라인` / `변경 전/후 diff` | 어떤 entity 의 타임라인인지 · diff 렌더링 수준 · 필터 유무 · 변경자 표기 |
| `05_v0.2 §11.4` | `감사로그 타임라인 + diff` | 위와 동일 |

즉 **API 도 화면도 구현체가 없고**(route 0개, 서비스 0개, 탭 0개) 계약을 코드에서
추론할 수밖에 없는 상태였다. 그래서 구현 전에 D-1~D-17 로 계약을 고정한다.

⚠️ `AuditLog` 자체는 T02 에서 이미 완성되어 있다 — 13 컬럼 · UPDATE/DELETE/TRUNCATE
불변 트리거 3종 · `(entity_type, entity_id, occurred_at DESC)` 인덱스 · `actorId`
FK RESTRICT. **이번 Task 는 그 위에 read path 만 얹는다.**

---

## 28. 이번 범위 — 정확히 둘

1. `GET /api/skus/{id}/history` (신규 read-only API)
2. SKU 상세 **⑧ 변경이력 탭**

⛔ 그 밖의 어떤 것도 만들지 않는다. 특히:

- global 감사로그 검색 화면·API (`/admin/audit-logs`, `GET /api/audit-logs`)
- 다른 엔티티의 history endpoint (`/api/external-mappings/{id}/history` 등)
- 사용자 조회 API · actor 이름 resolver
- 감사로그 export(엑셀/CSV) · 보존정책 · 아카이빙
- `AuditLog` write path · 트리거 · 스키마 변경

---

## 29. Entity boundary (D-1 · D-3) — `Sku` + 그 SKU 의 `SkuBarcode`

응답에 포함하는 감사로그는 **정확히 두 `entityType`** 이다.

| `entityType` | 포함 | 근거 |
|---|---|---|
| `Sku` | ✅ | `05 §10.3` 이 **SKU 의** history 라고 적었다 |
| `SkuBarcode` | ✅ | `05 §11.4` ③ 바코드가 SKU 상세의 child tab 이며 부모 없이는 존재할 수 없다 |
| `SkuExternalMapping` | ⛔ | ④ 외부매핑은 §19~§26 대로 **자기 관리화면(`EXT-MAP-001`)이 주인**이다. SKU history 에 넣으라는 근거가 원문에 없다 |
| Supplier 계열 · BOM | ⛔ | T06 · T07 이후. 모델 자체가 없다 |
| 그 밖(CommonCode·SystemSetting·User…) | ⛔ | SKU 상세의 범위가 아니다 |

### 29.1 barcode 이력을 찾는 방법 (D-2)

`AuditLog` 에는 `parentSkuId` 스냅샷이 없다. 추가하지 않는다 —
`10 §14`(감사로그 컬럼 확정)를 유지한다.

대신 **그 SKU 의 barcode id 를 1회 선조회**한 뒤 감사로그를 단일 쿼리로 읽는다.

```
SELECT id FROM sku_barcode WHERE sku_id = :skuId          -- 고정 1회
SELECT … FROM audit_log
 WHERE (entity_type='Sku' AND entity_id IN (:skuId))
    OR (entity_type='SkuBarcode' AND entity_id IN (:barcodeIds))
 ORDER BY occurred_at DESC, id DESC
 LIMIT 50 OFFSET (page-1)*50
```

- ⛔ **N+1 금지** — barcode 마다 감사로그를 따로 읽지 않는다.
- ⛔ **application merge 금지** — 두 결과를 앱에서 합쳐 정렬·자르지 않는다.
  페이지네이션은 **DB 레벨 단일 쿼리**여야 total 이 정확하다.
- ★ `SkuBarcode` 는 **물리삭제가 없고**(`status='INACTIVE'` 로만 내려간다)
  `deletedAt` 컬럼도 없다. 그래서 현재 id 목록만으로 과거 이력까지 전부 찾을 수 있다.
- ⚠️ **수용된 한계**: 만약 미래에 barcode 물리삭제가 생기면 그 이력은 이 방식으로
  찾을 수 없다. 그때는 `parentSkuId` 재검토가 아니라 **물리삭제 자체가 금지**다
  (`00 원칙` — 물리삭제 없음).
- ⚠️ barcode id 가 0개면 `SkuBarcode` 절을 아예 만들지 않는다.
  `entity_id IN ()` · `OR: []` 로 **전체 행이 선택되는 사고**를 막는다.

---

## 30. 권한 (D-4) — `sku.read` 재사용

`05 §10.3` 의 권한 칸 `전체` 는 **역할 표기**이지 permission 이름이 아니다.
SKU 상세를 볼 수 있으면 그 SKU 의 변경이력도 볼 수 있다 — 그래서
**`sku.read` 를 그대로 쓴다**.

- ⛔ 신규 permission(`audit.read` · `sku.history.read`) 을 만들지 않는다.
- ⛔ seed · `RolePermission` 데이터 변경 0.
- ⛔ 신규 route policy 0 — proxy 1차 가드의 기존 `/api/skus` GET → `sku.read`
  정책이 `/api/skus/{id}/history` 를 그대로 잡는다.
- ★ 그래도 서비스에서 **`assertPermission(actor, 'sku.read')` 2차 가드**를 재실행한다.
  proxy 통과를 신뢰하지 않는다.
- ⛔ **ADMIN bypass 없음** — `RolePermission` 데이터로만 판정한다.
- ⇒ 결과적으로 **⑧ 탭은 조건부 노출이 아니다**. SKU 상세에 들어온 사용자는
  ③ 바코드·④ 외부매핑과 달리 전원 이 탭을 본다.

---

## 31. API contract (D-5 · D-6)

```
GET /api/skus/{id}/history?page=1
```

**요청**

| 파라미터 | 허용 | 규칙 |
|---|---|---|
| `page` | ✅ | 1-base 정수. 생략 시 1. `0`·음수·비정수·비숫자 → **400** |
| `pageSize` | ⛔ | 서버가 **50 고정**. 보내면 **400** |
| 그 밖의 모든 키(`action`·`from`·`to`·`actorId`·`entityType`·`q`…) | ⛔ | **400** |

⛔ 미지원 파라미터를 **조용히 무시하지 않는다** — 필터가 걸린 줄 알고
잘못된 결론을 내리는 것이 빈 400 보다 위험하다.

**응답 200**

```jsonc
{
  "items": [
    {
      "id": "…",              // AuditLog PK
      "entityType": "Sku",    // "Sku" | "SkuBarcode"
      "entityId": "…",
      "action": "UPDATE",
      "beforeValue": {…} ,    // 저장된 JSON 그대로. CREATE 는 JSON null
      "afterValue": {…},
      "actorId": "…",         // UUID 원문
      "occurredAt": "2026-08-11T…Z",  // ISO-8601 UTC
      "reason": null           // string | null
    }
  ],
  "page": 1,
  "pageSize": 50,
  "total": 3,
  "totalPages": 1,
  "requestId": "…"
}
```

- item 은 **정확히 위 9개 필드**다. 더도 덜도 아니다.
- ⛔ `approvedBy` 를 넣지 않는다 (D-9). §11 의 중복예외 승인과 마찬가지로
  UUID 뿐이고 사용자 조회 API 가 없어 화면에 쓸 수 없다.
- ⛔ `AuditLog` 의 `requestId`·`sessionId`·`ipAddress` 를 **item 에 넣지 않는다**
  (D-13). 그건 global 감사 조회의 범위다. envelope 최상위의 `requestId` 는
  **응답 자체의 추적 ID** 로 전 API 공통 convention 이며 이것과 다르다.
- ⛔ 배열(`AuditLog[]`)을 그대로 반환하지 않는다 — `05 §10.3` 이 `page` 를 함께
  적었으므로 페이지 정보 없는 배열은 자기모순이다. 기존 목록 API 와 **동일한
  envelope** 을 쓴다.

**에러**

| 상황 | 코드 |
|---|---|
| 쿼리 위반 · `{id}` 가 UUID 아님 | **400** |
| 미인증 | **401** |
| `sku.read` 없음 | **403** |
| `{id}` SKU 없음 / soft-delete 됨 | **404** |
| 그 밖 | **500** |

⛔ 403 을 빈 목록(200)으로 위장하지 않는다. ⛔ 404 를 빈 목록으로 위장하지 않는다.

---

## 32. 정렬·페이지네이션 (D-7)

- 정렬 **`occurredAt DESC, id DESC`**. `occurredAt` 동시각 tie 를 `id` 로 깨서
  페이지 경계에서 행이 사라지거나 중복되지 않게 한다.
- ⛔ cursor pagination 을 만들지 않는다 — `05 §10.3` 이 `page` 다.
- `pageSize` 는 **서버 상수 50**.
- 이력이 0건이면 `200` · `items: []` · `total: 0` · **`totalPages: 0`**.
  ★ `Math.max(1, …)` 로 1 페이지가 있는 척하지 않는다.
- 존재하는 total 을 넘는 `page` 는 **200 + 빈 items** 다(400 아님) — 기존 목록
  API convention 과 같다.

---

## 33. 아키텍처 (D-15)

```
Route(/api/skus/[id]/history)
  → SKU Application Service (listSkuHistory: 권한·SKU 존재·barcode id 수집)
    → SKU repository (부모 SKU / barcode id)
    → Audit History Read Repository (findAuditHistoryPage)
      → Prisma
```

- ⛔ **Route 에서 Prisma 직접 접근 금지.**
- Audit read repository 는 `Pick<PrismaClient, 'auditLog'>` 만 받는다 —
  SKU 지식을 갖지 않고 `(entityType, entityIds)` 쌍만 받는 **범용 read** 다.
- ⛔ `AuditLog` **write path·`auditLogger`·불변 트리거를 건드리지 않는다.**
- schema · migration · permission · seed · route policy 변경 **모두 0**.

---

## 34. 변경자 표기 (D-8)

`actorId` **UUID 원문**을 `변경자` 라벨과 함께 표시한다.

- ⛔ 사용자 조회 API 를 만들지 않는다. ⛔ 이름을 추정하지 않는다.
- ⛔ `User` join 을 넣지 않는다 — 이번 범위 밖이며, 넣는 순간 감사로그 read 가
  사용자 모듈에 결합된다.
- ★ 이는 §11(중복예외 `approvedBy`)에서 이미 확정한 것과 **같은 convention** 이다.

---

## 35. diff UX (D-10 · D-11 · D-12)

행은 **summary 한 줄 + native `<details>` 펼침**이다.

**summary**: `occurredAt` · entity 배지 · action 라벨 · `변경자 {UUID}` ·
(있을 때만) `사유/메모 {reason}`

**펼침**: `변경 전` / `변경 후` 두 패널에 저장된 JSON 을 **그대로 pretty-print**
(2-space indent, `<pre>`).

- ⛔ field label 매핑 테이블을 만들지 않는다.
- ⛔ action 별 전용 렌더러(“상태가 X→Y 로 바뀜” 같은 문장 생성)를 만들지 않는다.
- ⛔ accordion framework · 3rd-party diff viewer 를 도입하지 않는다.
- ★ `beforeValue` 가 없는 CREATE 는 `null` 로 표시된다. 실제 저장값이
  **JSON `null`**(SQL NULL 아님)이므로 `—`·빈칸이 아니라 `null` 이 정확하다.
- nested object 를 평탄화하지 않는다.

### 35.1 라벨 (D-11)

| entityType | 라벨 |
|---|---|
| `Sku` | `SKU` |
| `SkuBarcode` | `바코드` |

| action | 라벨 |
|---|---|
| `CREATE` | 등록 |
| `UPDATE` | 수정 |
| `SUBMIT` | 승인 요청 |
| `APPROVE` | 승인 |
| `REJECT` | 반려 |
| `DEACTIVATE` | 비활성화 |
| `REQUEST_DUPLICATE` | 중복 예외 요청 |
| `APPROVE_DUPLICATE` | 중복 예외 승인 |

⚠️ 이 8종은 **현재 producer 가 실제로 쓰는 action** 이다. `ACTIVATE` 같은 값은
아직 어떤 writer 도 쓰지 않으므로 라벨을 미리 만들지 않는다 — 생기면 아래
fallback 으로 원문이 그대로 보인다.

★ **알 수 없는 action 은 원문 문자열을 그대로 표시한다.** 빈칸·`기타` 로 뭉개지
않는다 — 미래에 새 action 이 생겨도 이력이 사라지지 않아야 한다.

### 35.2 사유 (D-12)

라벨은 **`사유/메모`** 다. `reason` 이 `null`/빈 문자열이면 **줄 자체를 만들지
않는다** — ⛔ `—` placeholder 없음.

### 35.3 없는 것 (D-13)

⛔ action 필터 · 기간 필터 · 변경자 검색 · entity 필터 · 페이지 크기 선택 ·
엑셀 다운로드 · `requestId`/`sessionId`/`ipAddress` 표시.
API 가 `page` 만 받으므로 이런 UI 는 만들 수단 자체가 없다.

---

## 36. 탭 구성 (D-14)

**상세 6탭** — ① 기본정보 ② 코드·분류 ③ 바코드 ④ 외부시스템 매핑
⑤ 재고관리 설정 **⑧ 변경이력**.

- `05 §11.4` 의 **원문 순서를 유지**한다(⑥ 공급조건·⑦ BOM 은 T06·T07 이후이므로
  아직 없고, 구현된 탭만 순서대로 노출한다).
- ⑧ 은 항상 **마지막**이다.
- ⛔ 등록 화면(`/master/skus/new`)은 **3탭 그대로**다. 아직 생성되지 않은 SKU 에는
  변경이력이 존재할 수 없다 — placeholder·disabled 탭도 만들지 않는다.
- 페이지 이동은 **탭 내부 local state** 다. ⛔ URL `searchParams` 에 쓰지 않는다
  (③·④ 탭과 동일한 convention).
- 3건뿐이라 `totalPages <= 1` 이면 pagination 컨트롤 자체를 렌더하지 않는다.

---

## 37. 상태 표시

| 상태 | 표시 |
|---|---|
| 로딩 | `변경이력을 불러오는 중…` |
| 0건 | `변경이력이 없습니다.` |
| 403 | `변경이력 조회 권한이 없습니다. (403)` — ⛔ 빈 목록으로 위장 금지 |
| 400/404/500 | 공통 `ErrorBanner` (`code`·`message`·`requestId`) |

---

## 38. 인수조건 (T1-6B3)

1. `GET /api/skus/{id}/history` 가 `sku.read` 로 200 을 준다.
2. 응답 item 이 **정확히 9개 필드**다 — `approvedBy`·`sessionId`·`ipAddress`·
   AuditLog `requestId` 가 없다.
3. `Sku` CREATE/UPDATE/SUBMIT·`SkuBarcode` CREATE/UPDATE/DEACTIVATE/
   REQUEST_DUPLICATE/APPROVE_DUPLICATE 이력이 모두 나온다.
   `INACTIVE` 로 내려간 바코드의 **과거 이력도 그대로 남는다**.
4. **`SkuExternalMapping` 이력은 나오지 않는다.**
5. 다른 SKU 의 이력이 섞이지 않는다.
6. 정렬이 `occurredAt DESC, id DESC` 이고 동시각 tie 가 안정적이다.
7. 51건 이상이면 2페이지로 나뉘고 `total`·`totalPages` 가 맞으며, 탭의
   이전/다음 컨트롤이 URL 을 바꾸지 않고 페이지를 옮긴다.
8. 0건 → `items: []` · `total: 0` · **`totalPages: 0`**.
9. `pageSize=10`·`action=CREATE` 등 미지원 쿼리 → **400**.
10. 없는 SKU → **404**, 권한 없음 → **403**.
11. 상세 탭이 6개이고 마지막이 `변경이력`, 등록은 3탭 그대로다.
12. 상세 펼침에 변경 전/후 JSON 이 그대로 보이고 CREATE 의 before 는 `null` 이다.
13. schema · migration · permission · seed · route policy diff **0**.
14. AuditLog write path 변경 0 — 이 endpoint 는 **read-only** 다.

---

## 39. 범위 밖 재확인

⛔ global `/admin/audit-logs` · `GET /api/audit-logs` · 기간/actor/action 검색 ·
엑셀 export · 보존정책 · 다른 엔티티 history endpoint · 사용자 이름 resolver ·
`AuditLog` 컬럼 추가(`parentSkuId` 포함) · 감사로그 수정/삭제 경로 ·
DataIssue · InventoryException · T15 · T17.

---

## 40. 남은 범위 (§26 갱신)

| Task | 탭 | 상태 |
|---|---|---|
| **T1-6B1** | ③ 바코드 (+T04-4B) | **DONE** |
| **T1-6B2** | ④ 외부시스템 매핑 | **DONE** |
| **T1-6B3** | ⑧ 변경이력 | **이번 Task** |
| **T1-6B4** | ⑥ 공급조건 | **BLOCKED** — T06 이후 |
| **T1-6B5** | ⑦ BOM | **BLOCKED** — T07 이후 |

T1-6B3 이 끝나면 **T1-6B 중 T06/T07 에 의존하지 않는 부분은 전부 완료**다.

---

# T1-6B4 — ⑥ 공급조건 탭

(2026-08-13 T1-6B4 Supplier Tab Design Recovery Decision — D-1 ~ D-30 확정.
base `origin/main = 5ba63c714524e8097bc5ac5de0a851d9cce94804`,
branch `claude/t1-6b4-supplier-tab`.)

## 41. T1-6B4 PRE-FLIGHT 결과 — 왜 BLOCKED 였나

§40 이 "T06 이후"로 미뤄 둔 차단 사유는 T06-1~T06-4 완료로 해소됐지만,
**대체 화면 명세가 남아 있지 않았다.** ⑥ 탭의 authoritative 원문은 `05:336`
**한 줄**뿐이다:

> `공급업체별 SKU 목록, MOQ, 리드타임, 사급/턴키, 우선공급업체, 최근 단가`
> — **리드타임 미입력은 `—`로 표시(0 아님)**

BLOCKED 조건 7개가 전부 미확정이었고, 그중 셋이 구조를 좌우했다:

1. **SKU → SupplierSku 역조회 경로가 하나도 없다.** `/api/suppliers/{id}/skus`
   는 supplier-centric 이고, `/api/suppliers` 는 `skuId` 를 모르며(미지원
   파라미터 400), **`/api/supplier-skus` collection route 자체가 없다.**
   T1-6B2 가 `GET /api/external-mappings?skuId=` 로 "신규 API 0"을 달성한 것은
   그 필터가 T05-2 목록 계약에 **이미 있었기** 때문이며, supplier 에는 대응물이
   없어 같은 방식이 성립하지 않는다.
2. **`리드타임` 이 단수인데 API 는 stored/derived 두 값을 준다.**
3. **`최근 단가` 의 기준일·계산 위치·permission 경계가 비어 있다.**

## 42. D-1·D-2 — supporting API · module owner

supporting API 를 **정확히 1개** 추가한다:

```text
GET /api/skus/{id}/supplier-skus
```

⛔ 만들지 않는다: `GET /api/skus/{id}/suppliers`(반환 단위가 Supplier 가 아니라
어긋난다) · `GET /api/supplier-skus?skuId=`(없는 collection route 신설 +
standalone 관리 API 외형) · `/api/skus/{id}/supplier-prices`.

**T1-6B4 전용 read-only supporting API** 다 — standalone SupplierSku management
collection API 로 확장하지 않는다.

**D-2 module owner**: URL 은 SKU nested child route
(`src/app/api/skus/[id]/supplier-skus/route.ts`)지만 business query 는
SupplierSku 도메인이므로 application owner 는 **Supplier module** 이다:

```text
Route → Supplier Application Service(listSkuSupplierSummaries) → Prisma
```

⛔ route 에서 Prisma 직접 접근 없음. ⛔ SKU module 에 SupplierSku/Price business
query 를 중복 구현하지 않는다. T06-3 effective-price semantics 의 authoritative
owner 도 계속 Supplier module 이다.

## 43. §5 — SKU existence

path SKU 존재만 확인한다 — `deletedAt IS NULL`(SKU 상세와 같은 규칙).
없으면 **404**, malformed UUID 는 **400**.
⛔ `ACTIVE only`·`purchasable`·`sellable`·`manufacturable` 같은 eligibility 를
발명하지 않는다.

## 44. D-3·D-19 — permission contract ★

응답에 SupplierSku 정보와 **가격**이 함께 들어가므로 **두 capability 를 모두**
요구한다:

```text
supplier.read  AND  supplier_price.read
```

현재 role matrix 에서 둘 다 A·L·S·F 인 것은 **우연**이며 계약상 별개다 —
하나로 합치지 않는다.

- **proxy(1차)**: route-policy 는 경로당 permission 1개라
  `/api/skus` + `contains:'/supplier-skus'` + GET/HEAD → **`supplier.read`** 로
  잡는다. ⚠️ 이 정책을 일반 `/api/skus` GET(`sku.read`) 정책보다 **앞에** 둔다 —
  뒤에 두면 `sku.read` 만으로 공급조건·가격을 볼 수 있게 된다.
- **application(2차)**: service 가 `assertPermission` 을 **두 번** 호출한다.
  ⛔ ADMIN bypass 없음.

## 45. D-4 — 탭 visibility · D-25 fallback

탭은 `supplier.read` **AND** `supplier_price.read` 가 모두 있을 때만 보인다.
판정은 `/api/me.permissions` 문자열 포함 여부로만 한다 (⛔ 역할 이름 하드코딩).

| 역할 | 탭 |
|---|---|
| ADMIN · SCM_LEADER · SCM_STAFF · FINANCE | 표시 |
| **EXECUTIVE** | **숨김** |

★ EXECUTIVE 는 `sku.read` 가 있어 SKU 상세 자체는 열리지만 supplier capability
가 없어 이 탭이 보이지 않는다 — ④ 외부매핑 탭과 **같은 경계**이며, 같은
사용자에게 ③ 바코드 탭은 보인다.

**D-25**: 두 permission 중 하나라도 사라지면 `activeTab` 이 `basic` 으로
fallback 한다(기존 §12·T1-6B2 메커니즘 재사용). ⛔ 403 panel 을 남긴 채 탭을
유지하지 않는다.

## 46. D-5 — SupplierSku period scope ★

이 탭은 **history 화면이 아니다.** 반환 대상은 **업무일자 기준 현재 유효한
SupplierSku 만** 이다:

```text
effectiveFrom <= asOf AND (effectiveTo IS NULL OR asOf < effectiveTo)
```

half-open `[effectiveFrom, effectiveTo)` — 과거 종료 행 제외 · 미래 시작 행
제외(open-ended 라도 시작이 미래면 제외) · 오늘이 종료일이면 **이미 미적용**.

근거: T06-4 standalone 화면이 과거/현재/미래 전체 history 의 authoritative
owner 이고(docs/17 §95), 원문 열에 **적용기간이 없다**.

## 47. D-6·D-27 — 업무일자

⛔ 사용자가 `asOf` 를 입력하는 UI 를 만들지 않는다. ⛔ supporting API query 에
`asOf` 를 추가하지 않는다(보내면 400).

supporting API 가 **요청당 한 번** `Asia/Seoul` 업무일자를 계산하고, 같은
요청의 **SupplierSku current 판정과 recentPrice 판정이 정확히 같은 값**을 쓴다.
⛔ row 마다 `new Date()` 를 다시 부르지 않는다 — 자정 경계에서 행마다 날짜가
갈리면 안 된다. 응답 envelope 이 그 `asOf` 를 그대로 담는다.

**§11 helper**: external-mapping 모듈의 date helper 를 supplier 모듈이 직접
import 하는 cross-domain 의존을 만들지 않는다. 순수 계산을
**`src/shared/business-date.ts`** 로 최소 추출하고 external-mapping 은 거기서
re-export 한다 — **계산은 한 글자도 바뀌지 않았고** 기존 semantics·테스트는
그대로다(regression PASS). ⛔ 새 date framework 를 만들지 않는다.

## 48. D-14 — recent price exact meaning

`최근 단가` 는 이름과 무관하게 **현재 업무일자(asOf)에 유효한 승인 가격**이다:

```text
approvedBy IS NOT NULL
AND effectiveFrom <= asOf
AND (effectiveTo IS NULL OR asOf < effectiveTo)
```

⛔ 가장 최근 `createdAt` 아님 · 가장 최근 `effectiveFrom` 만 가진 행 아님 ·
pending 아님 · 기간 무관 최근 승인행 아님. T06-3 contract 를 그대로 재사용한다.

## 49. D-15·D-26 — 계산 위치 · batch resolver ★

⛔ client 가 SupplierSku 별로 `/prices?asOf=` 를 N 번 부르지 않는다.
⛔ 별도 batch REST endpoint 도 만들지 않는다.
**`GET /api/skus/{id}/supplier-skus` 가 `recentPrice` 까지 함께 반환**한다 —
탭 load 당 API 호출 1개가 원칙이다.

**D-26**: 단건 resolver 를 N 번 호출하지 않는다. Supplier module 에 batch
resolver 를 둔다:

```text
resolveEffectiveSupplierPrices(db, { supplierSkuIds, asOf })
  → Map<supplierSkuId, Price | null>   // 입력 id 전부가 key 로 존재
```

해당 페이지의 supplierSkuId 를 `IN (...)` 으로 묶어 **DB 조회 1회**로 가져오고,
application 이 id 별로 group 해서 판정한다:

```text
0건 → null · 1건 → 그 price · 2건 이상 → SUPPLIER_PRICE_CHAIN_CONFLICT
```

⛔ SQL 에서 id 별 top-1 을 잘라내지 않는다 — 잘라 버리면 2건 이상(손상)을
발견할 수 없다. ⛔ silent latest-row selection 금지.

**§15 single source of truth**: 단건 `resolveEffectiveSupplierPrice` 를 batch 의
**1-id wrapper** 로 바꿔 validity semantics 를 한 군데로 모았다. T06-3 의
public 동작(반환값·오류·predicate)은 **한 글자도 바뀌지 않았고** T06-3 DB/unit
regression 이 이를 고정한다.

## 50. D-18·D-17 — chain conflict · no-price/zero-price

**D-18**: 한 SupplierSku 라도 asOf 유효 승인 candidate 가 2건 이상이면
**요청 전체를 409 `SUPPLIER_PRICE_CHAIN_CONFLICT`** 로 실패시킨다.
⛔ 부분 row 성공 + warning 으로 숨기지 않는다. ⛔ `price=null` 로 downgrade 하지
않는다. UI 는 기존 `ErrorBanner` 로 표시한다. ⛔ 새 오류 코드를 만들지 않는다.

**D-17**: `recentPrice` 가 없으면 `null` → UI `—`. 실제 `unitPrice` 가 `"0"` 이면
UI `0 KRW`. **가격 없음과 0원을 절대 혼동하지 않는다.** ⛔ `||` fallback 금지.

## 51. D-7 — exact summary projection

**새 전용 축소 View** 다. ⛔ 기존 `SupplierSkuView` 전체를 그대로 반환하지 않는다.

```text
{ id, supplierId,
  supplier: { id, supplierCode, supplierName },
  supplierSkuCode, supplierSkuName,
  moq, effectiveLeadTimeDays,
  supplyType, isPrimary,
  recentPrice: { unitPrice, currency } | null }
```

타입: `moq: string | null` · `effectiveLeadTimeDays: number | null` ·
`supplierSkuCode/Name: string | null` · `recentPrice.unitPrice: string`.

⛔ 노출하지 않는다: `orderMultiple` · stored `leadTimeDays` · `purchaseUom` ·
SupplierSku `currency` · `effectiveFrom`/`effectiveTo` · `createdAt` ·
`destinationWarehouseId` · Supplier `status`/`supplierType` · Price `id`/
`vatIncluded`/`sourceDocument`/`createdBy`/`approvedBy`/`createdAt`.

## 52. D-19 envelope · D-21 pagination · D-20 ordering

query 는 정확히 **`page` 하나**(unknown query 400, default 1, 양의 정수).
서버 고정 `pageSize` **50**. response:

```text
{ items, page, pageSize: 50, total, totalPages, asOf, requestId }
```

0건이면 `items=[]` · `total=0` · `totalPages=0`.

**D-21**: 페이지 이동은 **탭 내부 local state** 다 — SKU 상세 URL/searchParams 에
supplier page 를 추가하지 않는다(T1-6B2/B3 선례). ⛔ page-size selector 없음.

**D-20 정렬 고정**: `supplier.supplierCode ASC, supplierId ASC, id ASC`.
⛔ `isPrimary DESC` 자동 정렬 금지 · ⛔ `effectiveFrom` 정렬 금지 — source 없는
우선공급업체 상단 배치를 발명하지 않는다.

## 53. D-13 — Supplier status filtering

`Supplier.status` 로 필터하지 않는다. SupplierSku 가 현재 유효하면 status 값과
무관하게 반환한다. ⛔ ACTIVE-only filtering 금지. status 는 View 에도 없다.

## 54. D-8 — exact 8 columns

```text
① 공급업체  ② 공급업체 SKU  ③ MOQ  ④ 리드타임
⑤ 공급유형  ⑥ 우선공급업체  ⑦ 최근 단가  ⑧ 관리
```

⛔ T06-4 관리화면의 14열 table 을 복사하지 않는다 — 그것은 관리 화면 열이다.

- **공급업체**(§24): `supplierName` 첫 줄 + `supplierCode` 보조 텍스트.
  ⛔ `supplierType`/`status` 표시 없음.
- **공급업체 SKU**(§25): `supplierSkuCode`·`supplierSkuName` 중 있는 것만,
  둘 다 없으면 `—`. ⛔ SKU 자체 `skuCode`/`skuName` 을 반복하지 않는다(상단에
  이미 있다).

## 55. D-9 — 리드타임은 **적용값**이다 ★

단일 `리드타임` 열은 **`effectiveLeadTimeDays`** 를 표시한다. 즉 SupplierSku
stored `leadTimeDays` 가 null 이면 `Supplier.defaultLeadTimeDays` fallback 결과가
보인다.

근거: 이 탭은 **입력값 관리 화면이 아니라 실제 적용되는 현재 공급조건 요약**
이다. stored/derived 를 둘 다 확인하려면 T06-4 관리화면으로 이동한다.

**D-9 표시**: `null → —` · **`0 → 0`** · 양수 → 숫자 (§00 G-03).
⛔ `||` 금지 — `0` 이 falsy 라 즉시납이 미입력으로 둔갑한다.
⛔ stored `leadTimeDays` 를 이 요약에 별도 표시하지 않는다.

## 56. D-10·D-11·D-12·D-16 — MOQ · SupplyType · isPrimary · recentPrice

- **D-10 MOQ**: `null → —`, 문자열은 **그대로**. ⛔ `Number()`/`parseFloat()` ·
  trailing zero 정규화 · 새 포맷 금지 — backend Decimal serializer 결과 그대로다.
- **D-11 SupplyType**: `SELF_SUPPLIED → 사급` / `TURNKEY → 턴키`. T06-4 가 확정한
  매핑과 **같은 값**이며 **unit 테스트가 두 매핑의 일치를 고정**한다. T06-4 의
  helper 는 관리화면 전용 위치에 있어 직접 cross-screen import 하지 않는다
  (T1-6B2 가 display helper 를 다룬 원칙과 동일). ⛔ T06-4 화면 동작 변경 없음.
- **D-12 isPrimary**: `true → 예` / `false → —` (T06-4 와 같은 표현).
  ⛔ checkbox/radio 등 mutation affordance 금지. ⛔ 대표 상단 sort 금지.
- **D-16 recentPrice**: API 는 `{unitPrice, currency} | null`, UI 는
  `null → —` / `{unitPrice} {currency}`(예: `1000 KRW`, **`0 KRW`**).
  ⛔ 숫자 coercion · VAT 계산/표시 · `sourceDocument`/승인자 표시 금지.

## 57. D-22·§32 — 관리 링크

각 행 `관리` 열에 **`거래처 관리에서 보기`** 링크를 둔다. exact target:

```text
/master/suppliers/{supplierId}?tab=terms
```

⛔ `?tab=prices` 로 보내지 않는다 · ⛔ `supplierSkuId` 를 붙이지 않는다 —
이 탭의 관리 대상은 공급조건 요약이고 그 authoritative target 은 T06-4
공급조건 탭이다.

탭 자체가 두 permission 조건으로 보이므로 링크에 **별도 권한 분기를 두지
않는다**(T1-6B2 §22 와 같은 원칙) — 링크는 read-only navigation 이다.

## 58. §37 — mutation control 0

⛔ 이 탭에 없어야 하는 것: `공급조건 추가` · `수정` · `기간 종료/단축` ·
`새 버전 생성` · `가격 등록` · `가격 승인` · `삭제`.
허용되는 action 은 **`거래처 관리에서 보기`** 뿐이다.

**D-28**: supporting GET 은 read-only 다 — **AuditLog 0** · `Idempotency-Key`
없음 · 데이터 mutation 0. write transaction 도 쓰지 않는다.

## 59. D-23 — loading / empty / error

기존 child-tab convention 재사용:

| 상황 | 표시 |
|---|---|
| loading | `공급조건을 불러오는 중…` |
| 0건 | **`등록된 공급조건이 없습니다.`** (T06-4 와 같은 문구) |
| 403 | 전용 문구. ⛔ 빈 목록으로 위장하지 않는다 |
| 400·404·409·500·네트워크 | `readApiError` → `ErrorBanner` |

⛔ 새 toast/state framework 금지. ⛔ 빈 상태에서 mutation/create 버튼 금지.

## 60. D-24 — tab insertion/order

`inventory` 와 `history` **사이**에 삽입한다. T1-6B4 이후 실제 탭:

```text
① 기본정보 ② 코드·분류 ③ 바코드 ④ 외부시스템 매핑 ⑤ 재고관리 설정
⑥ 공급조건 ⑧ 변경이력
```

즉 **7탭**이며 변경이력은 **여전히 마지막**이다. ⛔ BOM placeholder 없음 —
향후 T1-6B5/T07 이 ⑦ BOM 을 공급조건과 변경이력 사이에 넣는다.
탭 key 는 `supplier`, label 은 정확히 **`공급조건`**.

**§36 create route**: `/master/skus/new` 의 `SKU_CREATE_TABS` 는 **3탭 그대로**
다. ⛔ 공급조건 탭을 추가하지 않으며 child data fetch 도 발생하지 않는다
(배열이 분리돼 있어 구조적으로 보장된다).

## 61. §40·§46 — T06-4 regression boundary

T1-6B4 때문에 T06-4 standalone 화면의 route·3탭 구조·mutation·permission·
behavior 를 **변경하지 않았다**. 실제 T06-4 코드 변경 **0** 이다 —
`supplyTypeLabel` 도 값을 복제하고 unit 이 일치를 고정하는 방식이라
관리화면 파일을 건드리지 않았다.

기존 SKU 상세 B1/B2/B3 · Barcode · External Mapping · History · T06-2 · T06-3 ·
T06-4 테스트를 모두 유지한다. **탭 개수 snapshot(6 → 7)과 "⑥ 공급조건은 아직
없다" 류의 부재 단언은 이번 Task 가 바꾸는 대상 그 자체**이므로 새 사실로
갱신했다(E2E 4건 · unit 5건) — 그 밖의 계약은 손대지 않았다.

## 62. D-29·D-30 — tests · boundary

기존 stack 그대로 — **Vitest · DB integration · Playwright**. ⛔ React Testing
Library 등 신규 framework 도입 금지.

**허용(이번 Task)**: supporting GET 1개 · supplier module read application 확장 ·
batch effective price resolver · SKU 상세 read-only 탭 · 순수 display helper 최소
추출(business-date) · tests/docs/route policy.

⛔ **금지(전부 지켰다)**: T06-4 mutation 변경 · SupplierSku/Price mutation 추가 ·
T07 BOM · BOM placeholder · T08 Warehouse · Attachment · schema/migration ·
신규 permission/seed.

**§47**: Prisma schema 변경 **0** · migration 변경 **0** · 신규 permission **0** ·
seed 변경 **0**. 기존 `supplier.read`·`supplier_price.read` 만 쓴다.

## 63. 남은 범위 (§40 갱신)

| Task | 탭 | 상태 |
|---|---|---|
| **T1-6B1** | ③ 바코드 (+T04-4B) | **DONE** |
| **T1-6B2** | ④ 외부시스템 매핑 | **DONE** |
| **T1-6B3** | ⑧ 변경이력 | **DONE** |
| **T1-6B4** | ⑥ 공급조건 | **이번 Task** |
| **T1-6B5** | ⑦ BOM | **BLOCKED** — T07 이후 |

T1-6B4 가 끝나면 **T07 에 의존하지 않는 SKU 상세 탭은 전부 완료**다.
