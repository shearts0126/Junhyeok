# 설계복구 — SKU 상세 잔여 탭 (T1-6B) · 바코드 탭 V1 (T1-6B1)

> **2026-08-11 SKU Detail Remaining Tabs Design Recovery Decision**
>
> 이 문서는 T1-6B 분할과 **T1-6B1 구현 계약의 유일한 근거**다.
> 여기에 없는 규칙을 코드에서 추론해 만들지 않는다.

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
| **T1-6B1** | **③ 바코드** (+ **T04-4B** 흡수) | **이 문서로 IMPLEMENTABLE** | T04-3·T04-4A backend 100% |
| **T1-6B2** | ④ 외부시스템 매핑 | **DEFERRED** | 신규 API 0 으로 가능하나 `EXT-MAP-001` 과의 역할 분담·창고(T08-1) 미결 |
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
