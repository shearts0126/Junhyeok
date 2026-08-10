# 설계복구 — 바코드 중복 예외 승인 (T04-4A)

> **2026-08-10 Barcode Duplicate Approval Design Recovery Decision**
>
> 이 문서는 T04-4A 구현 계약의 **유일한 근거**다.
> 여기에 없는 규칙을 코드에서 추론해 만들지 않는다.

---

## 1. 배경 — candidate workflow 원문 부재

원문은 다음 두 줄이 전부다.

```
POST /api/skus/{id}/barcodes/{bid}/approve-duplicate
body {reason} 필수 · 권한 L,A · "실제 중복 확인 / 승인자·사유 기록"
```

여기에 **구조적 공백**이 있었다.

```
T04-1 DB   : UNIQUE(barcode) WHERE status='ACTIVE' AND duplicate_exception=false
T04-3 POST : duplicateException=false·status='ACTIVE' 강제
             → 중복이면 409 BARCODE_DUPLICATE, 행이 생기지 않는다
T04-4 URL  : .../{bid}/approve-duplicate → 승인할 row 가 이미 있어야 한다
```

즉 **승인할 `{bid}` 가 만들어질 경로가 없었다.** candidate 생성 방식·candidate status·
승인 후 status·중복의 범위·재승인·자가승인·동시성 — 7항목 전부 근거가 없어
`T04-4 PRE-FLIGHT BLOCKED` 로 보고했다. 이 문서가 그 빈 부분을 새 결정으로 확정한다.

`TC-SKU-005` 도 backlog 참조 3건뿐이고 given/when/then 정의 원문이 없다
(**TC-SKU-005 detailed contract missing**) — 이 문서의 계약이 그 자리를 대신한다.

### T04-4 분리

| Task | 범위 | 상태 |
|---|---|---|
| **T04-4A** | 중복 예외 **요청 + 승인 API** | 이 문서로 **IMPLEMENTABLE** |
| **T04-4B** | 승인 **UI** | Barcode UI 탭(T1-6B) 부재로 **deferred** |

T04-4 전체 COMPLETE 판정은 T04-4B 까지 끝난 뒤에 한다 → 현재 **PARTIAL**.

---

## 2. 최종 workflow

일반 POST 의 기존 계약은 **바꾸지 않는다.**

```
POST /api/skus/{skuId}/barcodes
  동일 ACTIVE barcode 존재 → 409 BARCODE_DUPLICATE, SkuBarcode 생성 없음
```

사용자가 의도적으로 바코드 공유를 요청하려면 별도 endpoint 를 호출한다.

```
POST /api/skus/{skuId}/barcodes/duplicate-candidates      ← candidate 생성
POST /api/skus/{skuId}/barcodes/{barcodeId}/approve-duplicate  ← 원문 endpoint 로 승인
```

---

## 3. 권한

신규 2종. `barcode.create`·`barcode.update` **재사용 금지**, ADMIN bypass 없음,
Proxy(1차) + Application Service(2차) 이중 guard.

| permission | 역할 |
|---|---|
| `barcode.request_duplicate` | ADMIN · SCM_LEADER · SCM_STAFF |
| `barcode.approve_duplicate` | ADMIN · SCM_LEADER |

route policy 는 두 경로를 **일반 바코드 정책보다 앞에** 둔다(첫 일치 우선).
그러지 않으면 두 POST 가 `barcode.create` 로 잡혀 승인 통제가 무너진다.

---

## 4. candidate status — `PENDING_DUPLICATE`

`sku_barcode.status` 는 `VARCHAR(20)` 이고 열거값 CHECK 가 없으므로
`'PENDING_DUPLICATE'`(18자)를 **컬럼 변경 없이** 저장한다.

최종 업무 status 3종: `ACTIVE` · `INACTIVE` · `PENDING_DUPLICATE`.

⛔ 일반 PATCH DTO 는 계속 `ACTIVE|INACTIVE` 만 받는다 — 사용자가 일반 PATCH 로
`PENDING_DUPLICATE` 를 직접 만들 수 없어야 한다.

---

## 5. candidate 요청

```
POST /api/skus/{skuId}/barcodes/duplicate-candidates
body: { barcode: string, barcodeType: BarcodeType, isPrimary?: boolean }
```

T04-3 `CreateBarcodeDto` 와 **동일한 strict 최소 계약**이며 unknown field 는 400 이다.
정규화도 T04-2/T04-3 경로를 그대로 재사용한다.

### 초기값

```
status             = PENDING_DUPLICATE
duplicateException = false
exceptionReason    = null
approvedBy         = null
barcode/barcodeType/isPrimary/skuId = 요청값(정규화된 barcode)
```

`countryCode`·`channelCode`·적용기간은 여전히 T04-3 V1 범위 밖이다.

---

## 6. "실제 중복"의 정의 — cross-SKU ACTIVE 만

candidate 를 만들려면 아래를 만족하는 `SkuBarcode` 가 **최소 1건** 있어야 한다.

```
other.id      != candidate.id
other.skuId   != targetSkuId
other.barcode == normalizedBarcode
other.status  == 'ACTIVE'
```

★ `other.duplicateException` 값은 **보지 않는다** — 이미 예외 승인된 ACTIVE 바코드와
또 다른 SKU 가 같은 값을 쓰려는 경우도 중복 예외 대상이다.

없으면 **422 `BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE`**.
(미입력 표시값 `-`·공란 등은 공유할 바코드 자체가 없으므로 같은 422 다.)

---

## 7. 같은 SKU 중복은 예외 대상이 아니다

동일 SKU 안에 같은 ACTIVE 바코드가 있는 경우는 **데이터 중복**일 뿐이며 예외 승인으로
허용하지 않는다. 같은 SKU 행만 존재하면 §6 조건(`other.skuId != targetSkuId`)이
성립하지 않으므로 **422 `BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE`** 로 거부된다.

중복 예외는 **서로 다른 SKU 사이의 실제 바코드 공유**만 허용한다.

---

## 8. candidate DB invariant

같은 SKU·같은 바코드에 승인 대기 후보가 여러 개 생기면 안 된다.

```sql
CREATE UNIQUE INDEX ux_barcode_pending_duplicate
ON sku_barcode(sku_id, barcode)
WHERE status = 'PENDING_DUPLICATE';
```

신규 migration 1개. **기존 migration 수정 금지.**
T04-1 의 두 partial index 와 **서로 다른 규칙**이며 합치지 않는다.
PostgreSQL catalog 로 이름·컬럼·predicate·유일성을 직접 검증한다.

---

## 9. candidate 중복 요청

같은 `skuId` + `barcode` + `status=PENDING_DUPLICATE` 후보가 이미 있을 때:

| 조건 | 결과 |
|---|---|
| `barcodeType`·`isPrimary` 까지 동일 | **200** 기존 후보 반환 — 새 row·AuditLog 없음 |
| 업무 필드가 다름 | **409 `BARCODE_DUPLICATE_CANDIDATE_EXISTS`** |

⛔ 기존 후보를 자동 수정하지 않는다. 동시 요청은 `ux_barcode_pending_duplicate` 가
최종 방어선이며, 제약 위반 후 처음부터 한 번 더 실행해 위 규칙을 그대로 적용한다.

⚠️ 이 business-level 재사용 판정은 **전역 멱등 판정보다 나중**이다 (§10 참조).

---

## 10. candidate 멱등성

기존 global idempotency 인프라를 그대로 재사용한다(새 framework 금지).

- `routeScope = '/api/skus/{id}/barcodes/duplicate-candidates'` — raw UUID 미포함
- hash = `{ skuId, ...validatedRawDto }` — **정규화 전** validated raw DTO 기준
- first **201** / same key+hash **200 replay** / same key+different hash **409 `IDEMPOTENCY_KEY_REUSED`**

candidate INSERT + AuditLog + 멱등 snapshot 은 **같은 트랜잭션**이다.

### ★ 전역 멱등 계약이 business 판정보다 우선한다

```
same scope + same key + same requestHash      → 저장된 결과 replay
same scope + same key + different requestHash → 409 IDEMPOTENCY_KEY_REUSED
```

는 **business-level candidate 재사용(§9)보다 먼저** 성립한다. 처리 순서는:

```
권한 → strict DTO → 정규화·물리 입력 검증 → requestHash 계산
→ 멱등 claim / 기존 기록 판정
     기존 + 같은 hash → 저장된 snapshot 즉시 replay
     기존 + 다른 hash → 409 즉시 반환
     새로 claim      → 아래 business 판정 진행
→ 부모 SKU → 실제 중복 → 기존 후보 → INSERT / 기존 후보 200 → snapshot
```

두 가지가 직접 따라온다.

1. **정규화 결과가 같아도 원문이 다르면 409다.** 같은 key 로 `"001-234"` 다음
   `"001234"` 를 보내면 business 후보는 동일하지만 hash 가 다르므로
   **409 `IDEMPOTENCY_KEY_REUSED`** 이며, 200 기존 후보로 빠지지 않는다.
2. **replay 는 현재 business state 를 재평가하지 않는다.** 최초 요청 후 상대
   ACTIVE 바코드가 사라져 지금이라면 422 일 상황이어도, 같은 key + 같은 hash 는
   저장된 snapshot 을 그대로 200 으로 낸다 — 새 row·AuditLog 를 만들지 않는다.

### 기존 후보 재사용도 "성공한 요청"이다

기존 후보를 그대로 돌려주는 200 응답은 `SkuBarcode` INSERT 0 · AuditLog 0 이지만,
**`IdempotencyRecord` 는 그 key 를 기억한다**(status 200 snapshot 저장). 따라서
그 key 로의 후속 요청은 같은 hash 면 replay, 다른 hash 면 409 다.
`Idempotency-Key` 헤더가 없으면 기존대로 멱등기록을 만들지 않는다.

검증 실패(400/422/409)는 claim 과 함께 롤백되므로 **실패한 요청이 key 를 점유하지 않는다.**

---

## 11. candidate AuditLog

```
entityType = SkuBarcode
entityId   = candidate.id
action     = REQUEST_DUPLICATE
actorId    = requester.id
afterValue = candidate 전체 업무 snapshot
```

⛔ 별도 `requestedBy` 컬럼을 만들지 않는다 — **요청 행위는 AuditLog 가 보존한다.**

---

## 12. 자가승인

바코드 중복 예외 승인에는 **자가승인 금지 정책을 추가하지 않는다.**
`barcode.request_duplicate` 와 `barcode.approve_duplicate` 를 모두 가진
SCM_LEADER·ADMIN 이 자신이 만든 후보를 직접 승인하는 것도 **허용**한다.

근거: 현재 승인된 자가승인 정책은 SKU/BOM 에 대해 별도로 존재하며
(`allow_self_approval_sku`/`_bom`, 항상 분리 3종), 바코드에는 금지 근거가 없다.

⛔ 다음을 만들지 않는다: `SkuBarcode.createdBy` · `requestedBy` ·
`allowSelfApprovalBarcode` · `allowSelfApprovalSku` 재사용.

---

## 13. 승인 요청 body

```
POST /api/skus/{skuId}/barcodes/{barcodeId}/approve-duplicate
body: { reason: string }   // strict
```

`reason` 은 trim 후 비어 있으면 **400** 이다. 저장·기록되는 값은 **trim 된 문자열**이다.
⛔ 임의 최대 길이를 추가하지 않는다 — `exception_reason`·`audit_log.reason` 모두 TEXT 이고
원문에 상한 근거가 없다.

---

## 14. 승인 대상

정확히 다음일 때만 승인한다.

```
skuId == 경로의 skuId
status == 'PENDING_DUPLICATE'
duplicateException == false
approvedBy == null
```

소유권 불일치는 **404** 다 — 다른 SKU 의 후보 존재 여부를 노출하지 않는다.

---

## 15. 승인 직전 실제 중복 재검증

후보 생성 시 확인했더라도 **승인 직전에 다시** 확인한다(§6 과 같은 조건).
없으면 **422 `BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE`** 이며 후보는
`PENDING_DUPLICATE` 그대로 남는다. 중복이 사라졌다면 예외를 승인할 이유가 없다.

---

## 16. 승인 mutation — 정확히 4개 필드

```
status              PENDING_DUPLICATE → ACTIVE
duplicateException  false → true
exceptionReason     null  → trimmed reason
approvedBy          null  → actor.userId
```

⛔ 절대 변경하지 않는다: `barcode` · `barcodeType` · `isPrimary` · `skuId` ·
`countryCode` · `channelCode` · `effectiveFrom` · `effectiveTo`.

---

## 17. `isPrimary` 와 대표 충돌

후보가 `isPrimary=true` 면 그대로 ACTIVE 전환을 시도한다. 해당 SKU 에 이미 다른
활성 대표가 있으면 T04-1 `ux_barcode_primary` 가 **409 `BARCODE_PRIMARY_CONFLICT`** 를
만들고 승인 트랜잭션 **전체가 롤백**된다. 후보는

```
status=PENDING_DUPLICATE · duplicateException=false · approvedBy=null · exceptionReason=null
```

그대로 유지된다. ⛔ 기존 대표 자동 해제 금지.

---

## 18. 재승인

이미 `status='ACTIVE'` + `duplicateException=true` 인 행에 재호출하면 **200 현재 행**(no-op).
`approvedBy` · `exceptionReason` · AuditLog **어느 것도 바뀌지 않는다** —
최초 승인자의 기록을 후속 호출자가 덮어쓰지 않는다.

마이그레이션으로 이미 `duplicateException=true` + `approvedBy != null` 로 들어온 행도
같은 경로에서 "이미 승인됨"으로 취급된다.

---

## 19. 비대상 상태

```
INACTIVE + duplicateException=false
ACTIVE   + duplicateException=false
PENDING_DUPLICATE + duplicateException=true
…
```

→ **422 `BARCODE_DUPLICATE_APPROVAL_INVALID_STATE`**. ⛔ 자동 상태수정 금지.

---

## 20~21. 동시성

승인 트랜잭션은 후보 행을 `SELECT … FOR UPDATE` 로 **먼저 잠그고** 상태를 다시 읽는다.
같은 트랜잭션에서 §6 조건의 상대 ACTIVE 행도 `FOR UPDATE` 로 잠가, 중복 확인과
승인 mutation 사이의 stale 판정을 줄인다. ⛔ 과도한 global/table lock 금지.

두 승인자가 같은 후보를 동시에 승인하면:

```
mutation 1건 · APPROVE_DUPLICATE AuditLog 1건
첫 요청  → 200 approved row
두 번째 → 잠금 해제 후 재조회 → 이미 승인됨 → 200 같은 row (no-op)
```

두 번째 actor 가 `approvedBy`·`exceptionReason` 을 덮어쓰지 않는다.

---

## 22. 승인 AuditLog

성공한 **최초 승인만** 기록한다.

```
entityType = SkuBarcode
entityId   = barcode.id
action     = APPROVE_DUPLICATE
actorId    = actor.userId
approvedBy = actor.userId
reason     = trimmed reason
before/after snapshot 기록
```

바코드 mutation 과 AuditLog 는 **같은 트랜잭션**이며, AuditLog 실패 시 승인도 롤백된다.

---

## 23. 일반 PATCH 우회 차단

현재 행이 `PENDING_DUPLICATE` 이면 일반 PATCH 를 **차단**한다 →
**422 `BARCODE_DUPLICATE_APPROVAL_PENDING`**.

특히 `PATCH {status:'ACTIVE'}` 로 승인 endpoint 를 **우회할 수 없어야 한다.**

---

## 24. 후보 취소 — DELETE

`PENDING_DUPLICATE` 후보는 기존 DELETE(= `status='INACTIVE'`)로 취소한다.

```
PENDING_DUPLICATE → DELETE → INACTIVE     (AuditLog action = DEACTIVATE, 기존 정책 유지)
```

취소 후 승인을 시도하면 **422 `BARCODE_DUPLICATE_APPROVAL_INVALID_STATE`** 다.
별도 취소 endpoint 를 만들지 않는다.

---

## 25. GET

기존 GET 이 `ACTIVE`·`INACTIVE`·`PENDING_DUPLICATE` 를 **모두** 반환한다.
새 filter·pagination 없음. UI 는 status 로 승인 대기 후보를 식별한다.

---

## 26. 마이그레이션 special path

`06_데이터_마이그레이션설계.md` §12.5 의 중복 이관

```
status=ACTIVE · duplicateException=true
exceptionReason='마이그레이션 이관 — 원본 중복' · approvedBy=마이그레이션 실행자
```

는 **이미 승인 완료된 special migration row** 다. T04-4 interactive candidate flow 를
다시 거치지 않는다. 해당 문서의 DataIssue 요구도 그대로 유지한다.

---

## 27. UI 분리

이번 범위는 **T04-4A API only** 다.
⛔ Barcode UI 탭 · 중복 승인 버튼 · 승인대기 목록 UI · T1-6B — 만들지 않는다.
T04-4B 는 T1-6B Barcode 탭 구현 시 합쳐 진행한다.

---

## 28. V7~V9

이번 범위에서 `approval-validation.ts` 를 변경하지 않는다.
V7 · V8 · V9 모두 계속 `NOT_APPLICABLE` 이며 T1-4B 는 OPEN 이다.

T04-4A 완료 후 T1-4B 에서 V9 를 연결할 때의 기준은 다음 방향으로 설계할 수 있다
(**실제 wiring 은 T1-4B 에서 별도 승인**):

> 동일 바코드를 사용하는 다른 SKU 의 ACTIVE row 존재
> **AND** 현재 SKU 의 해당 바코드가 `duplicateException=true` 로 정당화되지 않음

---

## 29. 신규 public error code

| code | HTTP |
|---|---|
| `BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE` | 422 |
| `BARCODE_DUPLICATE_CANDIDATE_EXISTS` | 409 |
| `BARCODE_DUPLICATE_APPROVAL_INVALID_STATE` | 422 |
| `BARCODE_DUPLICATE_APPROVAL_PENDING` | 422 |

기존 `BARCODE_DUPLICATE`(409) · `BARCODE_PRIMARY_CONFLICT`(409) 는 그대로 재사용한다.

---

## 부록 — 확정 계약 요약

| Method | URL | 요청 | 성공 응답 | permission | 멱등 |
|---|---|---|---|---|:-:|
| POST | `/api/skus/{id}/barcodes/duplicate-candidates` | `{barcode, barcodeType, isPrimary?}` | `201` / `200`(replay·기존 후보) | `barcode.request_duplicate` | ✅ |
| POST | `/api/skus/{id}/barcodes/{bid}/approve-duplicate` | `{reason}` | `200 SkuBarcode` | `barcode.approve_duplicate` | — |

| 상황 | 오류 |
|---|---|
| unknown field · blank reason | 400 `VALIDATION_ERROR` |
| 권한 없음 | 403 `FORBIDDEN` |
| 부모 SKU 없음 · 다른 SKU 의 barcodeId | 404 `NOT_FOUND` |
| 내용이 다른 후보 존재 | 409 `BARCODE_DUPLICATE_CANDIDATE_EXISTS` |
| 승인 시 활성 대표 충돌 | 409 `BARCODE_PRIMARY_CONFLICT` |
| 같은 멱등키 + 다른 내용 | 409 `IDEMPOTENCY_KEY_REUSED` |
| cross-SKU ACTIVE 중복 없음(같은 SKU 만 포함) | 422 `BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE` |
| 승인 대상 상태 아님 | 422 `BARCODE_DUPLICATE_APPROVAL_INVALID_STATE` |
| PENDING 후보 일반 PATCH | 422 `BARCODE_DUPLICATE_APPROVAL_PENDING` |
