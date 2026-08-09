# 09. 설계복구 결정 — SKU 코드 추천 (STANDARD_PRODUCT_V1)

| 구분 | 내용 |
|---|---|
| 결정일 | **2026-08-09** |
| 성격 | **Design Recovery Decision** — 유실된 원문을 대체하는 신규 확정 정책 |
| 적용 | T03-7 부터. `05 §10.4` 의 "코드 추천" 행이 가리키는 실체 |
| 선행 | `08_설계복구_승인전검증9종.md` (같은 유형의 PRD 유실 복구) |

## 1. 배경 — 원 PRD §11.1 / §11.5 유실

`05_API와_화면설계.md:56` 은 코드 추천 API 의 근거로 **PRD §11.5**("자동 저장하지
않음"), `00_요구사항_이해와_충돌검토_v0.2.md:340` 은 **PRD §11.1**("임의 재생성
금지")를 인용한다. 그러나 그 원문인 **SKU·BOM 상세 PRD v0.1 은 repository 와 git
이력 어디에도 없다** (T03-7 preflight 전수 확인 — `docs/` 삭제 이력도 0건).

preflight 에서 추가로 확인된 사실:

- 레거시 SKU 코드는 **품목별로 최소 4가지 체계**가 공존한다
  (`부록_AS-IS_최초분석노트.md` §1):
  | 형태 | 예 |
  |---|---|
  | 본품 `브랜드(2)-대분류(2)-소분류(2)-일련번호(3) [-추가코드]` | `FB-OY-CW-001` |
  | 부자재 `완제품품번-부자재분류(2)-일련번호(2)` | `FB-OY-CW-001-BX-01` |
  | 공용 부자재 `브랜드-CM-일련번호` | `FB-CM-002` |
  | 보관처 분기 `공용부자재-보관처축약(3)` | `FB-CM-002-CLB` |
- 예외 코드 실측: `FB-DP-016`·`FB-PM-001`·`FB-PM-013` 의 2번째 세그먼트는
  **MATERIAL_CATEGORY** 코드이며(3세그먼트) 위반으로 분류되지 **않았고**,
  `FB-SB` 는 문자 그대로 2세그먼트인데 위반으로 분류됐다.
- `BT` 는 MAJOR_CATEGORY(뷰티)와 MATERIAL_CATEGORY(용기류)에 **동시 존재**해,
  세그먼트만으로 체계를 역판정할 수 없다.
- serial scope·MAX+1 여부·자릿수 상한·`additionalCode` 포함 여부는 **어떤
  문서에도 없었다.**

따라서 아래를 **canonical 코드 추천 정책으로 복구 확정**한다. 원 PRD 를
발견했다는 주장이 아니라 새로 명시하는 정책이며, 원문이 발견되면 정오 기록과
함께 갱신한다.

## 2. 범위 — STANDARD_PRODUCT_V1 만 자동 추천

T03-7 은 모든 레거시 형식을 재현하는 범용 코드 생성기가 **아니다.** 자동 추천
대상은 다음 하나뿐이며 이름은 **`STANDARD_PRODUCT_V1`** 이다.

```
{BRAND.code}-{MAJOR_CATEGORY.code}-{MINOR_CATEGORY.code}-{NNN}
예: FB-OY-CW-001 · BO-BT-TN-001
```

⛔ 자동 생성하지 **않는** 체계: 부자재(`완제품코드-부자재분류-일련번호`),
공용부자재(`브랜드-CM-일련번호`), 보관처 분기(`공용부자재-보관처`), 기타 레거시
예외 코드. 이들 SKU 는 **사용자가 `skuCode` 를 직접 입력해 생성한다** —
"코드 추천을 쓸 수 없음" 은 "SKU 를 만들 수 없음" 이 아니다.

> 향후 부자재·공용부자재용 추천기가 필요하면 **별도 정책 결정**이 선행되어야
> 한다. 이 문서를 확장 해석해 임의 구현하지 않는다.

## 3. Endpoint — 경로 정정 (supersede)

기존 문서의 `POST /api/skus/{id}/suggest-code` 는 **신규 SKU 생성 시점에는 `{id}`
가 존재하지 않는 구조적 모순**이 있다. 이 결정으로 supersede 한다.

```
/api/skus/{id}/suggest-code   → superseded by
POST /api/skus/suggest-code
```

구 경로는 구현하지 않으며 redirect·alias·호환 라우트도 만들지 않는다.

**요청** (strict, 3개 모두 필수 · unknown field → 400)

```json
{ "brandId": "uuid", "majorId": "uuid", "minorId": "uuid" }
```

**응답** — `serialNumber` 를 함께 반환하도록 이번 결정에서 보완한다. `Sku` 에
`skuCode` 와 `serialNumber` 가 각각 존재하므로, UI 가 문자열을 다시 파싱해
serial 을 추론하게 만들지 않는다.

```json
{ "suggestedCode": "FB-OY-CW-017", "serialNumber": "017" }
```

## 4. 권한

새 permission **`sku.suggest_code`** — ADMIN · SCM_LEADER · SCM_STAFF.
FINANCE·EXECUTIVE 없음. 역할집합이 `sku.create`/`sku.update` 와 우연히 같더라도
**독립 capability** 로 둔다(코드 추천은 쓰기가 아니다). ADMIN bypass 없음,
proxy + application 이중 가드.

## 5. 규칙 확정

| 항목 | 확정 내용 |
|---|---|
| 세그먼트 값 | `CommonCode.code` **그대로** — 대소문자 변환·trim·alias 치환 금지. 대분류에 채널(OY/DS/MS)이 섞인 문제도 T03-7 에서 재설계하지 않는다 |
| CommonCode 검증 | brandId→BRAND, majorId→MAJOR_CATEGORY, minorId→MINOR_CATEGORY. 존재 + 올바른 group + `active=true`. 위반은 400 (T1-3 인프라 재사용). MAJOR↔MINOR 계층은 **검증하지 않는다**(규칙 부재) |
| serial scope | `(BRAND.code, MAJOR_CATEGORY.code, MINOR_CATEGORY.code)` 조합. brand·major·minor 중 하나라도 다르면 **독립 sequence** |
| serial 형식 | `001`~`999`. 정확히 3자리, ASCII digit, zero-padded. `000` 없음. 첫 번호는 `001` |
| 다음 번호 | **MAX + 1**. gap 재사용 금지 (`001,002,004` → `005`) |
| 계산 대상 | **soft-deleted 포함 모든 Sku 행**. status 무관(DRAFT~ARCHIVED·deletedAt≠null 전부 사용 이력) — 삭제·상태 변경으로 serial 이 재사용되면 안 된다 |
| legacy suffix | prefix 직후 세그먼트가 정확히 3자리 숫자면 뒤에 세그먼트가 더 있어도 **사용된 serial 로 계산**한다 (`FB-OY-CW-001-EU` → 001 사용) |
| 비정형 무시 | `FB-OY-CW-A01`·`-01`·`-0001` 은 serial 계산 대상이 아니다. 억지 정규화 금지 |
| additionalCode | 추천에 **포함하지 않는다.** 결과는 항상 4세그먼트. `-EU`·`-GL`·`-BK` 를 자동 부착하지 않으며, `additionalCode` 는 Sku 의 별도 metadata 로 유지한다. 레거시 suffix 코드는 원본 보존이며 신규 추천 규칙과 동일한 것으로 보지 않는다 |
| 상한 초과 | max 가 `999` 면 4자리 확장·다른 minor 대체 **금지**. `409 SKU_CODE_SEQUENCE_EXHAUSTED` |
| 후보 중복 방어 | 후보 생성 후 global `skuCode` 존재를 한 번 더 확인하고, 충돌 시 같은 cycle 안에서 다음 serial 을 시도한다. 999 초과 시 exhaustion |

## 6. 동시성 — 추천은 예약이 아니다

동시 호출 시 두 사용자가 **같은 코드를 받을 수 있으며 이는 허용**한다.
reservation/counter/sequence table·advisory lock·`FOR UPDATE` 를 만들지 않는다.

실제 생성 단계에서 첫 요청은 성공하고 두 번째는 T1-3 계약대로
**409 `SKU_CODE_DUPLICATE`** 다 — `sku_code` **전역 UNIQUE 가 최종 방어선**이며,
사용자는 추천을 다시 호출해 다음 번호를 받는다.

## 7. Side effect 없음

`suggest-code` 는 완전한 read-only 추천이다. `Sku` INSERT/UPDATE, AuditLog,
IdempotencyRecord, serial reservation, SystemSetting/CommonCode 변경 **전부
발생하지 않는다.** 따라서 `Idempotency-Key` 도 적용하지 않는다.

application 입력은 `brandId·majorId·minorId·actor` 뿐이며 **`skuId` 를 받지
않는다.** 기존 SKU 의 `hasTransaction` 도 검사하지 않는다 — 추천은 기존 SKU 수정이
아니기 때문이다. 추천 결과를 실제로 PATCH 하는 시점에 T1-2 `hasTransaction`
guard 가 적용된다.

## 8. 코드체계 WARNING 정책과의 분리

T03-7 이 STANDARD_PRODUCT_V1 을 생성한다고 해서 승인 검증 **V6
(`SKU_CODE_PATTERN_VIOLATION`)를 WARNING → ERROR 로 올리지 않는다.** 사용자가
비표준 `skuCode` 를 직접 입력해 생성하는 것은 계속 허용되며, 승인 단계의 V6
정책(`08` 문서: WARNING · CHECK_UNAVAILABLE)은 그대로다. T03-7 은 편의기능이지
SKU 생성 강제 정책이 아니다.

## 9. UI

T03-7 은 **API/domain/application 전용**이다. T1-6A 코드·분류 탭의 "코드 추천"
버튼은 이 Task 범위가 아니며, API FINAL APPROVE 후 별도 UI 연결 Task 에서 붙인다.
