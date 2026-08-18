# 설계복구 — BOM (T07 전체)

> **작성 시점**: 2026-08-13
> **대상**: `T07-1` ~ `T07-8` (v0.2 백로그 `T3-5` ~ `T3-12`) 및 `T1-6B5`
> **baseline**: `origin/main` = `2eb89b5d937df2cdf69a27096c3a8b9cd1e77357`
> **선행**: T07 PRE-FLIGHT = `BLOCKED — DESIGN RECOVERY REQUIRED`

이 문서는 **T07 전체 구현 계약의 유일한 근거**다. 구현자는 이 문서에 없는
semantics 를 추론하지 않는다.

---

## 1. 목적 · precedence

### 1.1 왜 T07-1 부터 바로 시작하지 못했나

PRE-FLIGHT 판정 근거 10개 중 **9개가 미정**이었고, 그중 스키마 자체의 의미를
못 정하게 만드는 것이 둘이었다.

1. **활성 BOM 교체 규칙이 문서끼리 직접 충돌한다.** `05:129` 는 activate 시
   `기존 ACTIVE 자동 INACTIVE` 를 요구하고, `03v2:903` 은 `EXCLUDE … WHERE
   status='ACTIVE'` 로 기간 중첩 자체를 거부한다. 전자를 그대로 구현하면
   predecessor 의 `effective_to` 가 열린 채 status 만 바뀌어 **EXCLUDE 를
   우회한 논리적 기간 중첩**이 남고, asOf 이력 조회가 두 버전을 반환한다.
   즉 `T07-1` 의 EXCLUDE 가 무엇을 보장하는 제약인지가 `T07-5` 결정에
   달려 있다.
2. **`bom_line` 중복 방지 제약이 동작하지 않는다.** `03v2:276` 의
   `UNIQUE(bom_header_id, component_sku_id, alternate_group)` 는
   `alternate_group` 이 nullable 이라 PostgreSQL 이 NULL 을 서로 다른 값으로
   취급한다. 실측상 383행 전량이 NULL 이므로(`01:190` "대체 부자재 미관리 ·
   이관 시 미사용") **중복 구성품이 전혀 막히지 않는다.**

그 밖에 cycle 알고리즘 · UOM · explode 공식 · SupplierSku 선택 ·
provisional · currency · VAT · concurrency 가 전부 비어 있었다.
따라서 D-1 ~ D-32 를 **한 번에** 확정한다.

### 1.2 precedence

충돌 시 우선순위:

| # | source |
|---|---|
| 1 | **이 문서(docs/18)의 Design Recovery Decision** |
| 2 | v0.2 명세 (`00v2`·`03v2`·`04v2`·`05v2`·`06v2`·`07v2`) |
| 3 | v0.1 명세 중 v0.2 가 supersede 하지 않은 세부 계약 |
| 4 | 기존 승인된 T0 · T1 · T04 · T05 · T06 architecture |
| 5 | actual code |

⛔ 기존 문서 원문을 삭제하지 않는다. 충돌 조항은 각 문서에
`SUPERSEDED BY docs/18 §Dx` 형식으로만 표기한다.

### 1.3 재발명 금지 — 이미 승인된 공통 계약

아래는 이미 코드에 있고 T07 이 **그대로 쓴다**.

| 계약 | 위치 |
|---|---|
| Decimal 은 항상 문자열 (`Number()`/`parseFloat()` 금지) | `src/shared/decimal` · T1-3 |
| 멱등 framework `executeWithIdempotency` | `src/shared/idempotency` |
| `AuditLogger` (business write 와 같은 트랜잭션) | `src/modules/audit` |
| `allowSelfApprovalBom` 설정 | `schema.prisma:148` · D-07 · PENDING #6 |
| `assertApprovalActor({workflow:'BOM'})` | `src/modules/settings/domain/self-approval.ts` |
| `businessDateOf` (Asia/Seoul 업무일자) | `src/shared/business-date.ts` (T1-6B4) |
| `resolveEffectiveSupplierPrice(s)` | `src/modules/supplier/application/resolve-effective-price.ts` (T06-3·T1-6B4) |
| `btree_gist` + `EXCLUDE USING gist` 선례 | `20260812010000_add_supplier_and_supply_terms` |
| **ADMIN bypass 금지** (RolePermission 데이터로만 판정) | `route-policy` · `assertPermission` |
| Route → Application → Domain/Port → Infrastructure | `02 §모듈구조` · 전 Task |
| `null → —` / **`0 → 0`** 표시 규칙 (G-03) | T05-4A · T06-4 · T1-6B4 |
| 미지원 파라미터는 **400** (조용한 무시 금지) | T1-3 이후 전 Task |

### 1.4 복구 불가 원문

**`SKU·BOM 상세 PRD v0.1` 이 repository 에 존재하지 않는다.**
`05:126` 의 `검증규칙 14종 (PRD §22)` · `PRD §20.2` · `PRD §24.3` · `PRD §30.1`
· `PRD §38` 은 원문을 확인할 수 없다. `08_설계복구_승인전검증9종.md` 가
`§15.1` 을 복구한 것과 **같은 방식**으로, 이 문서가 14종을 D-13·D-10·D-12 로
복구·확정한다(§3.13 표).

#### ★ "검증규칙 14종" 은 historical title 이다 — 현재 authoritative 는 12종

혼동을 막기 위해 확정한다.

| 항목 | 확정 |
|---|---|
| `14종` 의 성격 | 원 backlog·`05:126` 이 **참조한 제목**일 뿐이다. 열거된 14개 목록 자체가 저장소에 없다 |
| 참조 대상 | `SKU·BOM 상세 PRD v0.1 §22` — **저장소에 존재하지 않는다** |
| 현재 authoritative | Design Recovery 로 복구 가능한 **enforceable rules 12종** (§3.13 표) |
| 미복구 2종 | ⛔ **임의로 발명하지 않는다.** 숫자를 맞추기 위한 규칙 추가를 금지한다 |
| acceptance 기준 | 원본 PRD 가 복구되지 않는 한, **T07 구현 acceptance 는 이 문서에 열거된 12종**을 기준으로 판정한다 |

⚠️ 이 문서에서 이후 등장하는 `14종` 표기는 **historical title 을 가리키는
참조**이며, 강제 대상 규칙의 개수를 뜻하지 않는다. 강제 대상은 언제나 §3.13 표다.

#### §3.13 — authoritative enforceable rules 12종

| # | 규칙 | 근거 | 성격 | 오류코드 |
|---|---|---|---|---|
| 1 | `quantityStatus=UNKNOWN` ⇒ `quantityPer` 는 `null` | D-10 | pure | `BOM_QTY_STATUS_MISMATCH` |
| 2 | `SUGGESTED`·`CONFIRMED` ⇒ `quantityPer` 필수 | D-10 | pure | `BOM_QTY_STATUS_MISMATCH` |
| 3 | `quantityPer > 0` (0·음수 거부) | D-10 | pure | `BOM_QTY_INVALID` |
| 4 | submit 게이트 — `isRequired` 라인 전부 `CONFIRMED` | D-10 | pure | `BOM_QTY_UNCONFIRMED` |
| 5 | 라인 `uom` == 구성품 `baseUom` | D-11 | pure | `BOM_UOM_MISMATCH` |
| 6 | 헤더 `outputUom` == parent `baseUom` | D-11 | pure | `BOM_UOM_MISMATCH` |
| 7 | `parentSkuId ≠ componentSkuId` | D-12 | pure | `BOM_SELF_COMPONENT` |
| 8 | 상위 SKU `status ≠ DRAFT` | D-12 | data-dependent | `BOM_PARENT_NOT_ELIGIBLE` |
| 9 | 구성품 SKU `status ≠ ARCHIVED` | D-12 | data-dependent | `BOM_COMPONENT_NOT_ELIGIBLE` |
| 10 | 그래프 순환 금지 | D-13 | data-dependent | `BOM_CYCLE_DETECTED` |
| 11 | 전개 깊이 ≤ `BOM_MAX_LEVEL`(10) | D-13 | data-dependent | `BOM_MAX_LEVEL_EXCEEDED` |
| 12 | asOf 유효 ACTIVE BOM ≤ 1건 | D-22 | data-dependent | `BOM_EFFECTIVE_CONFLICT` |

⛔ **강제하지 않는 것**(근거 문서 없음): 상위 `manufacturable=true` · 구성품
`itemType` 제한 · `inventoryManaged=false` 배제 · `componentRole=SERVICE` 배제.

---

## 2. PRE-FLIGHT findings 요약

| 항목 | 상태 |
|---|---|
| BOM 구현물 | **0건** — 모델·migration·라우트·permission·오류코드·테스트 전무 |
| `bom_header`/`bom_line` 설계 초안 | `03v2:876-935` 에 **scalar 19 / 18** 개 **완비** (v0.1 과 동일). ⚠️ PRE-FLIGHT 는 `(relation)` 행을 포함해 `20/19` 로 셌으나, authoritative contract 는 **D-2 의 scalar 19 / 18 + relation 5 / 2** 다 |
| enum 4종 | `03v2:588-592` 에 값 확정 |
| API | `05v2 §10.8` 에 **18 endpoint** URL 확정, DTO 6종은 **이름만** |
| UI | `05v2 §11.8`·`§11.9` 에 목록·상세 명세 **존재** (T06-4 때와 다름) |
| permission | seed 에 `bom.*` **0개** |
| proxy | `/api/boms*`·`/master/boms` → **정책 없음**(인증-only), `/api/skus/{id}/where-used` → **`sku.read` 로 shadow** |
| 준비된 인프라 | `allowSelfApprovalBom` · `assertApprovalActor('BOM')` · `btree_gist` · price resolver · `canArchiveSku(hasBomUsage)` |
| E2E | `BOM 탭 toHaveCount(0)` **부재 단언 5건** — T1-6B5 가 갱신할 대상 |

---

## 3. Design Recovery Decision (D-1 ~ D-32)

### D-1 — task decomposition

`07:110-119` **EPIC-07 = `T07-1` ~ `T07-8`, 정확히 8개**를 authoritative task ID 로
유지한다. v0.2 `T3-5`~`T3-12` 는 같은 작업의 재넘버링이며 **scope 2건을 추가**
했다(아래 ✏️). 새 task 번호를 발명하지 않는다.

| task | title | v0.2 | v0.2 추가 scope |
|---|---|---|---|
| **T07-1** | `BomHeader`/`BomLine` 스키마 + `(parentSkuId, version)` UNIQUE + 활성기간 EXCLUDE(raw SQL) | T3-5 | — |
| **T07-2** | BOM 도메인: 순환 탐지(DFS), 검증규칙 14종 | T3-6 | maxLevel 명시 |
| **T07-3** | BOM CRUD API. 활성 BOM 수정 차단 | T3-7 | — |
| **T07-4** | 소요량 관리: `quantityPer` nullable + `quantityStatus` 3단계, 자동 1 금지, `packQuantity` 분리 | T3-8 | — |
| **T07-5** | 승인·활성화·복사(버전 생성) 워크플로 | T3-9 | — |
| **T07-6** | BOM 다단계 전개 (재귀, 순환 방어, maxLevel) | T3-10 | ✏️ **최대 조립가능수량 조회** |
| **T07-7** | BOM 원가 계산 (기준일 유효 가격이력, 미확정 시 `잠정`) | T3-11 | — |
| **T07-8** | BOM 목록·상세 화면 + 소요량 일괄 확정 UI | T3-12 | ✏️ **BOM 동기 업로드** |

**T07-7 은 implementation subdivision 을 적용한다** — `T07-7A` / `T07-7B`.
backlog ID `T07-7` 을 대체하지 않으며 PR 을 둘로 나누는 용도로만 쓴다.

- **T07-7A** — 단일 레벨 원가: SupplierSku 선택(D-23) · price resolver 재사용
  (D-24) · currency/VAT subtotal(D-26·D-27) · provisional(D-25). blocker 가
  전부 여기 모여 있다.
- **T07-7B** — multi-level roll-up: explode 결과 위의 원가 집계 · 반제품 원가
  전파 · aggregation(D-20) 연동.

**`T07-6` 의 `max-assembly-qty` 는 T07-6 에서 구현하지 않고 유예한다.**
근거: 최대 조립가능수량은 **현재고**(`inventory_balance`)를 필요로 하는데
재고 코어는 R1a-2(`T2-*`)이며 T07 의 선행조건이 아니다. v0.2 가 T3-10 에
넣은 것은 재고 코어 완료를 전제한 배치이므로, **T07-6 은 전개만** 하고
`GET /api/boms/{id}/max-assembly-qty` 는 **R1a-2 이후 별도 Task** 로 남긴다.
(이 유예는 `05v2:163` 을 삭제하지 않고 시점만 옮긴다.)

**`T07-8` 의 BOM 동기 업로드는 `PENDING #7` 확정 전까지 제외**한다.
`PENDING:24` 가 6조건(전체 검증 후 반영 · bulk · 부분성공 금지 · 재실행 안전 ·
시간초과 시 미반영 · 처리시간 테스트)을 요구하고 미충족 시 **CLI 제공**으로
분기하도록 열어 둔 미확정 항목이다. T07-8 은 화면만 구현한다.

**T1-6B5 삽입 시점** — `T07-3` 완료 직후. 근거는 D-30.

### D-2 — `BomHeader` / `BomLine` schema

`03v2:876-935` 를 **필드 추가·삭제 없이** 채택한다(v0.1 과 동일 명시).

#### `BomHeader` — scalar 19 개

| 필드 | 타입 | 계약 |
|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | |
| `parentSkuId` | `String @db.Uuid` | FK → `Sku`, `onDelete: Restrict` |
| `bomType` | `BomType` | required, 3종 |
| `version` | `String @db.VarChar(20)` | D-4 |
| `status` | `BomStatus @default(DRAFT)` | D-6 |
| `outputQty` | `Decimal @default(1) @db.Decimal(18,6)` | > 0, D-19 |
| `outputUom` | `String @db.VarChar(20)` | required, D-11 |
| `effectiveFrom` | `DateTime @db.Date` | required, D-5 |
| `effectiveTo` | `DateTime? @db.Date` | nullable, D-5 |
| `productionPartnerId` | `String? @db.Uuid` | **FK → `Supplier`** (아래) |
| `destinationWarehouseId` | `String? @db.Uuid` | **staged scalar — FK 없음** (D-32) |
| `overallLossRate` | `Decimal? @db.Decimal(8,6)` | D-19 |
| `description` | `String?` | |
| `changeReason` | `String?` | clone 시 필수(D-6) |
| `createdAt` | `DateTime @default(now()) @db.Timestamptz` | |
| `createdBy` | `String? @db.Uuid` | FK → `User`, `onDelete: Restrict` |
| `approvedAt` | `DateTime? @db.Timestamptz` | |
| `approvedBy` | `String? @db.Uuid` | FK → `User`, `onDelete: Restrict` |
| `activatedAt` | `DateTime? @db.Timestamptz` | |

**relation 5 개** — scalar 와 **분리해서 센다**. 구현 편의를 위한 임의 추가가
아니라, 위에서 확정한 FK scalar 와 `lines` inverse 의 **Prisma 표현**이다.

| relation | 대응 | 방향 |
|---|---|---|
| `parentSku` | `parentSkuId` FK | → `Sku` |
| `productionPartner` | `productionPartnerId` FK | → `Supplier` |
| `createdByUser` | `createdBy` FK | → `User` |
| `approvedByUser` | `approvedBy` FK | → `User` |
| `lines` | — | ← `BomLine.bomHeader` inverse |

⛔ `destinationWarehouseId` 에는 relation 이 **없다** — staged scalar 다 (D-32).

`productionPartnerId` 는 **`Supplier` FK 로 연결한다**. 근거: `03v2:242` ERD 가
`BOM_HEADER` 에서 SKU 만 FK 로 그리지만 `01:157` 이 P열(제조사)을 `supplier`
매핑으로 확정했고, `Supplier` 모델이 **이미 존재**한다(T06-1 merged). 미래
모델 대기 상태가 아니므로 staged scalar 로 둘 이유가 없다. `onDelete: Restrict`.

`destinationWarehouseId`·`issueWarehouseId` 는 **FK 없는 UUID scalar** 다 —
`Warehouse` 는 T08-1 이고 T07-1 의 선행조건(`T03-1`)에 없다. T06-1 이
`SupplierSku.destinationWarehouseId` 를 같은 이유로 staged scalar 로 둔
선례(`docs/17 §14`)를 그대로 따른다.

⛔ **Attachment 필드를 신규 추가하지 않는다.** BOM 에는 문서상 attachment 참조가
0건이며 `SupplierSkuPrice.attachmentId` 같은 staged 컬럼조차 없다.

#### `BomLine` — scalar 18 개

| 필드 | 타입 | 계약 |
|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | |
| `bomHeaderId` | `String @db.Uuid` | FK → `BomHeader`, **`onDelete: Restrict`** |
| `lineNo` | `Int` | `UNIQUE(bomHeaderId, lineNo)` |
| `componentSkuId` | `String @db.Uuid` | FK → `Sku`, `onDelete: Restrict` |
| `quantityPer` | `Decimal? @db.Decimal(18,6)` | D-10 |
| `quantityStatus` | `QuantityStatus @default(UNKNOWN)` | D-10 |
| `uom` | `String @db.VarChar(20)` | required, D-11 |
| `lossRate` | `Decimal? @db.Decimal(8,6)` | D-19 |
| `componentRole` | `ComponentRole` | required, 4종 |
| `supplyType` | `SupplyType?` | 기존 enum 재사용 |
| `alternateGroup` | `String? @db.VarChar(50)` | D-3 |
| `isRequired` | `Boolean @default(true)` | D-10 |
| `issueWarehouseId` | `String? @db.Uuid` | **staged scalar** (D-32) |
| `packQuantity` | `Decimal? @db.Decimal(18,6)` | ⛔ 소요량 아님 |
| `specification` | `String?` | |
| `legacyBomCode` | `String? @db.VarChar(100)` | 마이그레이션 추적 |
| `legacyCommonBomCode` | `String? @db.VarChar(100)` | 마이그레이션 추적 |
| `note` | `String?` | |

**relation 2 개** — scalar 와 분리해서 센다.

| relation | 대응 | 방향 |
|---|---|---|
| `bomHeader` | `bomHeaderId` FK | → `BomHeader` |
| `componentSku` | `componentSkuId` FK | → `Sku` |

⛔ `issueWarehouseId` 에는 relation 이 **없다** — staged scalar 다 (D-32).

`bomHeaderId` FK 를 **`Restrict`** 로 둔다 — `03v2` 는 `onDelete` 를 명시하지
않았으나 프로젝트 원칙이 물리삭제 금지이고 `SupplierSkuPrice` 가 부모
CASCADE 를 명시적으로 거부한 선례(`schema.prisma` 주석)를 따른다. 라인의
물리삭제는 D-6 의 제한된 경로로만 한다.

#### enum 4종 (`03v2:588-592` 그대로)

```
enum BomStatus      { DRAFT PENDING_APPROVAL REJECTED APPROVED ACTIVE INACTIVE ARCHIVED }
enum BomType        { MANUFACTURING KIT REPACK }
enum ComponentRole  { PRODUCT MATERIAL PACKAGING SERVICE }
enum QuantityStatus { CONFIRMED SUGGESTED UNKNOWN }
```

⛔ 값을 추가·삭제하지 않는다. `SupplyType` 은 기존 enum 을 재사용한다.

#### 기존 모델의 inverse relation

BOM 의 FK 는 상대 모델에 inverse relation 을 요구한다(Prisma 규칙). 아래가
**전부**이며, ⛔ 그 밖의 필드·제약·동작은 하나도 바뀌지 않는다.

**`Sku`** — inverse **2개만**.

```
bomHeaders BomHeader[] @relation("BomParent")      // 이 SKU 를 상위로 갖는 BOM 버전
bomLines   BomLine[]   @relation("BomComponent")   // 이 SKU 가 구성품으로 쓰인 라인 (역전개)
```

**`Supplier`** — inverse **1개만**. `BomHeader.productionPartner` 의 짝이다.

```
bomHeaders BomHeader[] @relation("BomProductionPartner")
```

**`User`** — inverse **2개**. `BomHeader.createdByUser` / `approvedByUser` 의 짝이다.

```
createdBomHeaders  BomHeader[] @relation("BomHeaderCreatedBy")
approvedBomHeaders BomHeader[] @relation("BomHeaderApprovedBy")
```

⛔ `Warehouse` 쪽 inverse 는 **없다** — 모델 자체가 없으며 T08-1 이다 (D-32).

### D-3 — duplicate line constraint

`03v2:276` 의 `UNIQUE(bom_header_id, component_sku_id, alternate_group)` 을
**그대로 구현하지 않는다.** NULL 로 무력화되어 완료조건 "중복 라인 차단"
(`05:122`)을 충족하지 못한다.

**확정 계약**

> 하나의 BOM 안에서 **(구성품 SKU, 대체그룹)** 조합은 **1개만** 허용한다.
> `alternateGroup` 이 `NULL` 인 라인들은 **서로 같은 그룹**으로 취급한다.

**구현 방법 — 표현식 UNIQUE 인덱스 (raw SQL)**

```sql
CREATE UNIQUE INDEX "ux_bom_line_component_group"
  ON "bom_line" ("bom_header_id", "component_sku_id", COALESCE("alternate_group", ''));
```

선택 근거:

- `NULLS NOT DISTINCT` 는 **채택하지 않는다.** PostgreSQL 15+ 에서 쓸 수 있고
  런타임은 16 이지만, `docs/00 C-09` 가 *"PG15의 `NULLS NOT DISTINCT` 는
  Prisma 가 지원하지 않으므로 사용하지 않음"* 을 이미 승인된 결정으로 두었다.
  같은 프로젝트에서 규칙을 뒤집지 않는다.
- **센티넬 정규화(`COALESCE(…, '')`)는 C-09 자신이 채택한 방식**과 같다
  (`lot_no=''`, `expiry_key='9999-12-31'`). 컬럼을 NOT NULL 로 바꾸지 않고
  인덱스 표현식으로만 처리해 `03v2` 의 nullable 선언을 유지한다.
- 부분 UNIQUE 2개(`WHERE alternate_group IS NULL` / `IS NOT NULL`) 조합보다
  단순하고, 두 인덱스 사이의 경합을 만들지 않는다.
- raw SQL 로만 존재하므로 `schema.prisma` 에는 **주석으로만** 기록한다.
  T06-1 의 partial UNIQUE·EXCLUDE 가 같은 방식이며 drift gate 를 통과한다.

**같은 componentSku 라도 `alternateGroup` 이 다르면 복수 라인을 허용한다.**
(대체 부자재 그룹이 존재 이유이므로.) 실측상 383행 전량 NULL 이라 이관 시에는
**구성품당 1라인**만 허용된다.

위반 시 → `BOM_LINE_DUPLICATE` / **409** (D-29).

#### ★ `alternateGroup` 정규화 — 센티넬은 DB 전용이다

인덱스가 `NULL` 과 `''` 를 **같은 키**로 접는 이상, API 가 두 값을 서로 다른
business value 로 남기면 의미가 갈린다(`{alternateGroup: ""}` 과
`{alternateGroup: null}` 이 응답에서는 달라 보이는데 DB 에서는 충돌한다).

> **`alternateGroup` 은 저장 전에 `trim` 하고, trim 후 빈 문자열이면 `null` 로
> 정규화한다.** 따라서 **`alternate_group = ''` 인 행은 존재할 수 없다.**

| 계층 | 계약 |
|---|---|
| API DTO | `optional`·`nullable` string. `trim` → blank 면 `null` (D-14) |
| 도메인·저장 | `null` 또는 **1~50자 non-blank** 문자열뿐 (D-9) |
| DB 인덱스 | `COALESCE(alternate_group, '')` — 센티넬 `''` 은 **NULL uniqueness 정규화 전용**이며 business value 가 아니다 |
| 응답 | 저장값 그대로(`null` 또는 non-blank) |

⛔ API 가 실제 빈 문자열을 저장하는 경로를 만들지 않는다.
⛔ 컬럼을 `NOT NULL DEFAULT ''` 로 바꾸지 않는다 — `03v2` 의 nullable 선언을 유지한다.

### D-4 — version identity

| 항목 | 확정 |
|---|---|
| 타입 | `String @db.VarChar(20)` — 문자열 |
| 생성 | **client supplied**. 서버 자동 채번 없음 |
| UNIQUE | `(parentSkuId, version)` |
| clone | `newVersion` 도 client supplied, **필수** |
| 정규화 | 입력값 **trim**. trim 후 빈 문자열이면 **400** |
| 길이 | trim 후 1~20자. 초과 400 |
| 대소문자 | **case-sensitive**. `v1.0` 과 `V1.0` 은 다른 버전이다 |
| 파싱 | ⛔ **semantic version 파싱·비교 금지.** 정렬은 문자열 정렬이 아니라 **`effectiveFrom`** 으로 한다 |

⛔ "다음 버전"을 계산하지 않는다 — 문자열이라 정의 불가하며 원문에도 없다.
UI 는 직전 버전 문자열을 **placeholder 로만** 보여줄 수 있다(자동 입력 금지).

중복 → `BOM_VERSION_DUPLICATE` / **409** (P2002 매핑, D-29).

### D-5 — effective period

`SupplierSku` 계약을 복사하지 않는다. BOM 은 **EXCLUDE 의 적용 범위가 다르다.**

| 항목 | 확정 | 근거 |
|---|---|---|
| 타입 | `@db.Date` (date-only) | `03v2` |
| `effectiveFrom` | **required** | `03v2` NOT NULL |
| `effectiveTo` | nullable (열린 구간 = 무기한) | `03v2` |
| 구간 | **half-open `[from, to)`** | `03v2:903` `daterange(…,'[)')` |
| CHECK | `effective_to IS NULL OR effective_to > effective_from` | T06-1 선례 |
| same-day 교체 | **허용** — predecessor 를 `to = T` 로 닫고 successor 가 `from = T` 로 시작하면 경계가 맞닿을 뿐 중첩이 아니다 | `[from,to)` 의 성질 |
| 중첩 금지 범위 | **`status='ACTIVE'` 인 행끼리만** | `03v2:903` `WHERE (status='ACTIVE')` |
| DRAFT/PENDING/APPROVED 간 중첩 | **허용** — 여러 후보 버전을 동시에 준비할 수 있어야 한다 | EXCLUDE 의 WHERE 절 |
| 미래 버전 activate | **허용** (D-7) | `05:129` `{effectiveFrom?}` |
| historical backfill activate | **허용** (D-7) | T06-3 가 같은 문제를 이미 지원 |
| SKU 당 asOf 시점 ACTIVE | **최대 1개** | EXCLUDE 의 귀결 |
| SKU 당 asOf 시점 ACTIVE 0개 | **정상 상태** — 오류가 아니다 | `06v2:286` "활성 BOM 0건" |

★ **`DRAFT` 도 `effectiveFrom` 이 필수**다. `03v2` 가 NOT NULL 이고, 마이그레이션이
전량 `effective_from = cutover_date` 로 이관한다(`01:190`). 생성 시 값이 없으면
**400** — 서버가 오늘로 채우지 않는다.

### D-6 — workflow graph

`BomStatus` 7종의 transition 을 **전량 확정**한다. 문서에 없던 4건을 여기서 정한다.

| from | to | trigger | 권한 | 비고 |
|---|---|---|---|---|
| — | `DRAFT` | `POST /api/boms` · `…/clone` | `bom.create` | |
| `DRAFT` | `PENDING_APPROVAL` | `…/submit` | `bom.submit` | 검증규칙 14종 통과 필수 |
| `REJECTED` | `PENDING_APPROVAL` | `…/submit` | `bom.submit` | ★ **재제출 허용** |
| `PENDING_APPROVAL` | `APPROVED` | `…/approve` | `bom.approve` | D-8 |
| `PENDING_APPROVAL` | `REJECTED` | `…/reject` | `bom.approve` | `{reason}` 필수 |
| `APPROVED` | `ACTIVE` | `…/activate` | `bom.approve` | D-7 |
| `ACTIVE` | `INACTIVE` | `…/deactivate` | `bom.approve` | `{effectiveTo, reason}` 필수 |
| `DRAFT`·`REJECTED` | `ARCHIVED` | `…/archive` | `bom.approve` | ★ **신규 endpoint** |

**문서에 없어 여기서 확정한 4건**

1. **`REJECTED → DRAFT` 는 만들지 않는다.** 대신 `REJECTED` 에서 편집을
   허용하고 `submit` 으로 바로 `PENDING_APPROVAL` 에 재진입한다. 상태를 두 번
   왕복시키면 audit 이 늘 뿐 얻는 것이 없다. (`05:123` 이 line DELETE 를
   `DRAFT/REJECTED만` 으로 허용하는 것과 정합한다 — 즉 원문도 `REJECTED` 를
   **편집 가능 상태**로 본다.)
2. **`INACTIVE → ACTIVE` 재활성은 금지한다.** 사용종료된 버전을 되살리면
   `effectiveTo` 가 이미 확정된 기간과 EXCLUDE 가 충돌하고, 무엇보다 이력이
   되돌려진다. 같은 내용이 필요하면 **clone 으로 새 버전**을 만든다 —
   이것이 "활성 BOM 직접 수정 금지 → 신규 버전" 원칙과 같은 방향이다.
3. **`ARCHIVED` 진입 경로를 신설한다.** enum 에만 존재하고 endpoint 가 없어
   고아 상태였다. **`POST /api/boms/{id}/archive`** 를 추가하고 대상 status 를
   **`DRAFT`·`REJECTED` 로만** 제한한다 — 한 번이라도 발효된 버전
   (`APPROVED` 이후)은 이력이므로 보관 대상에서 제외한다. 물리삭제가 아니라
   목록에서 감추는 용도다.
4. **`APPROVED` 상태의 수정은 금지한다.** `05:150` 은 `ACTIVE` 만 명시하지만,
   승인된 내용을 승인 후에 바꿀 수 있으면 승인 자체가 무의미하다. 수정이
   필요하면 clone 한다.

**편집 가능 상태 요약**

| status | header PATCH | line 추가/수정 | line 삭제 |
|---|:-:|:-:|:-:|
| `DRAFT` | ✅ | ✅ | ✅ |
| `REJECTED` | ✅ | ✅ | ✅ |
| `PENDING_APPROVAL` | ⛔ | ⛔ | ⛔ |
| `APPROVED` | ⛔ | ⛔ | ⛔ |
| `ACTIVE` | ⛔ `BOM_ACTIVE_IMMUTABLE` | ⛔ | ⛔ |
| `INACTIVE`·`ARCHIVED` | ⛔ | ⛔ | ⛔ |

`ACTIVE` 위반만 `BOM_ACTIVE_IMMUTABLE`(422, 원문 코드)이고, 나머지 편집 불가
상태는 `BOM_NOT_EDITABLE`(422, D-29)다. ⛔ **generic `status` PATCH 를 만들지
않는다** — 상태는 전용 endpoint 로만 바뀐다(T1-4A 와 같은 원칙).

`clone` 은 **모든 status 에서** 가능하다(원본을 읽기만 하므로). 단 결과물은 새
`effectiveFrom` 을 갖는 별개 candidate 이므로 **복제 직후 cycle 검사를 거친다**
(D-13).

### D-7 — active replacement ★ 핵심

#### 확정 계약

> **`ACTIVE` 는 "지금 이 순간 유효하다"가 아니라 "이 버전의 적용기간이 발효
> 승인되었다"는 뜻이다.** 어느 시점에 실제로 유효한 버전인지는 **status 가 아니라
> `[effectiveFrom, effectiveTo)` 와 asOf** 가 결정한다.
>
> 따라서 새 버전을 activate 할 때 predecessor 의 **`status` 를 바꾸지 않고
> `effectiveTo` 를 닫는다.**

이 재정의가 status 와 effective period 의 의미를 분리한다. `INACTIVE` 는
**명시적 `deactivate`(사용종료)** 전용으로 남으며, 버전 교체의 부작용으로는
절대 발생하지 않는다.

#### chain 알고리즘 (`POST /api/boms/{id}/activate`)

T06-3 가격 chain 과 **같은 구조**다 — 이미 구현·검증된 패턴을 재사용한다.

```
T := body.effectiveFrom ?? target.effectiveFrom      -- D-7.1
1. 부모 SKU 행을 FOR UPDATE 로 잠근다                  -- D-28
2. target.status 가 APPROVED 가 아니면 422
3. target.effectiveFrom := T
4. 같은 parentSkuId 의 status='ACTIVE' 행만 후보로:
     predecessor := effectiveFrom < T 중 effectiveFrom 최대
     successor   := effectiveFrom > T 중 effectiveFrom 최소
5. predecessor 가 있고 (effectiveTo IS NULL OR effectiveTo > T) 이면
     predecessor.effectiveTo := T           -- status 는 그대로 ACTIVE
6. target.effectiveTo := successor?.effectiveFrom ?? null
7. target.status := ACTIVE, target.activatedAt := now()
8. EXCLUDE 가 최종 backstop 이다 (23P01 → 409)
```

#### 요구 5개 충족 확인

| 요구 | 충족 방식 |
|---|---|
| 1. 동일 parent SKU 에 asOf 기준 ACTIVE 최대 1개 | EXCLUDE 가 ACTIVE 기간 중첩을 거부 → asOf 를 포함하는 ACTIVE 구간은 최대 1개 |
| 2. 이력 기간이 논리적으로 겹치지 않음 | 5단계가 predecessor 를 실제로 닫는다 |
| 3. 미래 activate 와 일관 | T 가 미래여도 predecessor 는 `[…, T)` 로 살아 있어 **오늘은 여전히 predecessor 가 유효**하다 |
| 4. predecessor 의 historical period 보존 | `effectiveFrom` 을 건드리지 않고 `effectiveTo` 만 닫는다 |
| 5. race 안전 | 부모 SKU FOR UPDATE 직렬화 + EXCLUDE 이중 방어 |

#### edge case 확정

| case | 처리 |
|---|---|
| `body.effectiveFrom` 생략 | target 의 기존 `effectiveFrom` 사용. ⛔ 서버가 오늘로 덮어쓰지 않는다 |
| **T 가 미래** | 허용. predecessor 는 `[…, T)` 로 닫히고 오늘은 predecessor 가 유효. ⛔ predecessor 를 지금 INACTIVE 로 바꾸지 않는다 — 그러면 현재 BOM 이 사라진다 |
| **T 가 predecessor.effectiveFrom 보다 이전** (historical 삽입) | 허용. 이 경우 predecessor 는 정의상 존재하지 않고 successor 만 있다 → `target.effectiveTo = successor.effectiveFrom`. 앞이 비어 있으면 그 구간은 ACTIVE BOM 없음(정상) |
| T 가 predecessor.effectiveFrom **과 같음** | `(parentSkuId, version)` 은 다르지만 기간이 완전히 겹친다 → 5단계에서 `effectiveTo := T = effectiveFrom` 이 되어 CHECK(`to > from`) 위반 → **409 `BOM_PERIOD_OVERLAP`**. 같은 날 시작하는 두 버전은 만들 수 없다 |
| predecessor 가 이미 `effectiveTo <= T` | 닫지 않는다(5단계 조건). 두 구간 사이에 **gap** 이 생기며 이는 정상이다 |
| successor 없음 | `target.effectiveTo := null` (무기한) |
| ACTIVE 가 하나도 없음 | predecessor·successor 모두 없음 → 그대로 activate |
| 반복 activate (이미 ACTIVE) | **200 no-op** — write 0 · audit 0. T06-3 repeat approve 와 같다 |

#### superseded

`05:129`(v0.1) / `05v2:158`(v0.2) 의 **`기존 ACTIVE 자동 INACTIVE`** 는
`SUPERSEDED BY docs/18 §D-7` 이다. 같은 이유로 `07:*` E2E-06 완료조건의
`구 버전 자동 INACTIVE` 도 **`구 버전 적용기간 자동 마감`** 으로 대체한다
(관찰 가능한 결과 — "구 버전이 더 이상 유효하지 않다" — 는 동일하다).

### D-8 — approve vs activate

두 endpoint 를 **유지하고 책임을 완전히 분리**한다.

| | `POST …/approve` | `POST …/activate` |
|---|---|---|
| status | `PENDING_APPROVAL → APPROVED` | `APPROVED → ACTIVE` |
| 타임스탬프 | `approvedAt` · `approvedBy` | `activatedAt` |
| effective period | ⛔ **건드리지 않는다** | ✅ chain 계산(D-7) |
| 다른 버전 영향 | ⛔ **없다** | ✅ predecessor `effectiveTo` 마감 |
| 자가승인 검사 | ✅ `assertApprovalActor({workflow:'BOM'})` | ⛔ **없다** |
| lock | 없음 (해당 행만) | 부모 SKU `FOR UPDATE` |
| body | `{note?}` | `{effectiveFrom?}` |
| 멱등 | 자연 멱등 (반복 200 no-op) | 자연 멱등 (반복 200 no-op) |
| permission | `bom.approve` | `bom.approve` |

**자가승인은 `approve` 에만 적용한다.** 근거: `05v2:156` 이
`allow_self_approval_bom` 을 approve 행에만 표기했고, D-07 의 취지가 "요청과
승인의 분리"이므로 승인 이후의 발효 실행에 다시 같은 제약을 걸 근거가 없다.
`activate` 는 `bom.approve` permission 만으로 판정한다.

요청자 판정 기준은 **`createdBy`** 다. BOM 에는 `submittedBy` 컬럼이 없고
(`03v2` 20필드에 없음) 신설하지 않는다. `createdBy` 가 `NULL` 이면(마이그레이션
유입분) 자가승인 검사를 **통과**시킨다 — 비교 대상이 없으므로 같은 사람일 수
없다. (T06-3 의 `createdBy` 취급과 동일.)

### D-9 — line schema 필드별 계약

| 필드 | required | 수정 가능 상태 | validation | API 표현 |
|---|:-:|---|---|---|
| `lineNo` | ✅ | DRAFT·REJECTED | 정수 ≥ 1, BOM 내 UNIQUE | number |
| `componentSkuId` | ✅ | DRAFT·REJECTED | UUID, 존재, `≠ parentSkuId`, cycle 검사(D-13) | string |
| `quantityPer` | ⛔ | DRAFT·REJECTED | D-10 | **string** (Decimal) · null |
| `quantityStatus` | ⛔ (default `UNKNOWN`) | DRAFT·REJECTED | D-10 정합 | enum 문자열 |
| `uom` | ✅ | DRAFT·REJECTED | D-11 | string |
| `lossRate` | ⛔ | DRAFT·REJECTED | `0 ≤ x < 1`, Decimal(8,6) | **string** · null |
| `componentRole` | ✅ | DRAFT·REJECTED | enum 4종 | enum 문자열 |
| `supplyType` | ⛔ | DRAFT·REJECTED | enum 2종 | enum 문자열 · null |
| `alternateGroup` | ⛔ | DRAFT·REJECTED | **`trim` → blank 면 `null`**, 아니면 1~50자. ⛔ `''` 저장 불가 (D-3) | string · null |
| `isRequired` | ⛔ (default `true`) | DRAFT·REJECTED | boolean | boolean |
| `issueWarehouseId` | ⛔ | DRAFT·REJECTED | UUID 형식만(**존재 검증 없음** — T08) | string · null |
| `packQuantity` | ⛔ | DRAFT·REJECTED | > 0, Decimal(18,6) | **string** · null |
| `specification` | ⛔ | DRAFT·REJECTED | | string · null |
| `legacyBomCode` | ⛔ | **서버 전용** | 마이그레이션만 기록 | 응답에만 |
| `legacyCommonBomCode` | ⛔ | **서버 전용** | 마이그레이션만 기록 | 응답에만 |
| `note` | ⛔ | DRAFT·REJECTED | | string · null |
| `id`·`bomHeaderId` | — | **불변** | | 응답에만 |

`lossRate` 상한을 `< 1` 로 둔다 — D-19 의 공식이 가산식이라 수학적으로는 1 이상도
계산되지만, 손실률 100% 이상은 업무상 오류이므로 **DTO 에서 422** 로 막는다
(DB CHECK 는 걸지 않는다 — 문서 근거가 없다).

`legacyBomCode`·`legacyCommonBomCode` 는 **API 요청에서 400** 이다(server-owned).

### D-10 — quantity / status consistency

**14종 검증 중 소요량 관련 규칙**을 여기서 확정한다.

| `quantityStatus` | `quantityPer` | 허용 상태 |
|---|---|---|
| `UNKNOWN` | **`null` 이어야 한다** | 모든 편집 상태 |
| `SUGGESTED` | **`> 0` 필수** | 모든 편집 상태 |
| `CONFIRMED` | **`> 0` 필수** | 모든 편집 상태 |

불일치 → `BOM_QTY_STATUS_MISMATCH` / **422** (D-29).
`quantityPer <= 0` → `BOM_QTY_INVALID` / **422**. `0` 과 음수 모두 거부한다
(TC-BOM-002).

**⛔ 자동 1 입력 절대 금지** (`03v2:918`, `01:188`, G-02). 서버·클라이언트
어디서도 `quantityPer` 를 기본값으로 채우지 않는다. 이것이 TC-BOM-010 이다.

**`packQuantity` → `quantityPer` 자동 전환 금지** (`05:122`, F-19). `1 ÷ packQuantity`
는 **UI 추천값**일 뿐이며, 사용자가 수락 버튼을 눌러야 저장된다. 수락 시
`quantityStatus` 는 **`SUGGESTED`** 가 아니라 **`CONFIRMED`** 다 —
`SUGGESTED` 는 **마이그레이션이 자동 생성한 값**을 뜻하는 상태이며(`06v2:253`),
사람이 수락한 순간 확정이다.

**submit 게이트** — `isRequired = true` 인 라인 중 `quantityStatus ≠ CONFIRMED`
가 하나라도 있으면 `submit` 을 **422 `BOM_QTY_UNCONFIRMED`** 로 막는다
(`05v2:155`, 완료조건 14). `isRequired = false` 라인은 게이트 대상이 아니다.

**`bulk-confirm-qty`** — `[{lineId, quantityPer}]` 를 받아 각 라인을
`quantityPer` 설정 + `quantityStatus := CONFIRMED` 로 만든다.
`UNKNOWN`·`SUGGESTED`·`CONFIRMED` 어느 상태에서 출발하든 결과는 `CONFIRMED` 다.
전량 검증 후 **한 트랜잭션에서 전부 반영**하며 부분 성공을 만들지 않는다.
라인 하나라도 `<= 0` 이면 전체 422.

### D-11 — UOM

**확정 계약**

> `BomLine.quantityPer` 는 **구성품 SKU 의 `baseUom` 기준 수량**이다.
> 따라서 `BomLine.uom` 은 **해당 구성품 SKU 의 `baseUom` 과 반드시 같아야 한다.**
> **T07 은 단위 환산을 수행하지 않는다.**

| 항목 | 확정 |
|---|---|
| `BomLine.uom` | 구성품 `Sku.baseUom` 과 불일치 시 **422 `BOM_UOM_MISMATCH`** |
| 생략 시 | 요청에서 `uom` 을 생략하면 **구성품의 `baseUom` 으로 서버가 채운다** (추론이 아니라 유일 허용값이므로 안전) |
| `BomHeader.outputUom` | parent `Sku.baseUom` 과 같아야 한다. 동일 규칙 |
| `SupplierSku.purchaseUom` | ⛔ **BOM 계산에 사용하지 않는다** — 구매 단위이며 사용 단위와 다른 축이다 |
| 환산 | ⛔ **없다.** 환산 계수 테이블·필드가 저장소에 존재하지 않는다 |

**기존 데이터와의 정합 확인** — `06v2 §12.7` BOM 매핑표에 **`uom` 열이 없다.**
원본 엑셀에 BOM 라인 단위 컬럼 자체가 존재하지 않으므로(`01 §2.2` B~AB 전체
확인), 마이그레이션은 **`uom := 구성품 SKU 의 baseUom`** 으로 채울 수밖에
없다. 즉 이 결정은 실측 데이터와 **충돌하지 않고 오히려 유일하게 가능한 값**이다.
`Sku.baseUom` 은 `@default("EA")` 로 항상 값이 있다.

환산이 필요해지면 **별도 conversion contract 를 먼저 만든 뒤** BOM 을 확장한다.
지금 넣으면 근거 없는 계수를 발명하게 된다.

### D-12 — component eligibility

`14종` 중 구성품 관련 규칙.

| 규칙 | 확정 | 근거 |
|---|---|---|
| `parentSkuId == componentSkuId` | **금지** → 422 `BOM_SELF_COMPONENT` | TC-BOM-001 |
| 간접 순환 | **금지** → 422 `BOM_CYCLE_DETECTED` | TC-BOM-007, D-13 |
| `componentRole = SERVICE` | **허용** | `01:193` 임가공비 464원이 실제 라인 |
| 구성품 `inventoryManaged = false` | **허용** | 위와 같음 |
| parent `manufacturable = true` 강제 | **하지 않는다** | 근거 문서 없음. 새 규칙 발명 금지 |
| parent SKU status | **`DRAFT` 를 제외한 전 status 허용** | `05:119` "상위 SKU 승인 상태" 를 최소 해석 |
| 구성품 SKU status | **`ARCHIVED` 만 금지** → 422 `BOM_COMPONENT_NOT_ELIGIBLE` | 폐기된 SKU 를 새로 편성할 수 없다 |
| 구성품 `itemType` 제한 | **없다** | 근거 없음 |

`05:119` 의 `상위 SKU 승인 상태` 는 어느 status 인지 명시하지 않는다. `ACTIVE` 로
좁히면 BOM 을 SKU 승인 전에 준비할 수 없어 실무상 막히고, 아무 제한도 없으면
문구가 무의미하다. **`DRAFT` 만 제외**가 최소 해석이며, 위반 시
`BOM_PARENT_NOT_ELIGIBLE` / 422 다.

### D-13 — cycle detection

#### 대전제 — 검사 대상은 "BOM row 의 집합"이 아니라 "한 시점의 graph" 다 ★

> cycle 검사 그래프는 **하나의 evaluation date 에서 parent SKU 마다 정확히
> 하나의 버전을 선택해** 구성한다. 여러 버전의 edge 를 union 하지 않는다.

이 대전제가 없으면 **실제로는 어느 시점에도 동시에 존재하지 않는 edge 조합**으로
가짜 순환(false positive)을 만든다. BOM 은 같은 parent SKU 에 여러 버전을 동시에
가질 수 있고, `ACTIVE` 조차 적용기간이 다른 여러 버전이 공존할 수 있기 때문이다.

**false positive 예시**

candidate `X` = `B v1` (DRAFT, `effectiveFrom = 2027-06-01`, 구성품 `C`).
기존 데이터:

```
A v1  ACTIVE  [2020-01-01, 2027-01-01)  → B      ← 2027-01-01 에 이미 마감됨
A v2  ACTIVE  [2027-01-01, ∞)           → D      ← B 를 갖지 않는다
C     ACTIVE  [2020-01-01, ∞)           → A
```

| 방식 | 그래프 | 판정 |
|---|---|---|
| **union**(폐기) | `A→B` · `A→D` · `B→C` · `C→A` | `B→C→A→B` ⇒ **CYCLE (오판)** |
| **evaluation date 선택**(확정) | `D = 2027-06-01` → `A` 는 `v2` 뿐 → `B→C` · `C→A` · `A→D` | `B→C→A→D` ⇒ **정상** |

`A v1` 과 `A v2` 는 **같은 날 동시에 유효한 적이 없다.** `A → B` edge 는
2027-01-01 에 이미 사라졌는데, union 은 그것을 영구히 살려 두어 **선택될 리 없는
버전의 edge 로 새 BOM 을 무기한 차단**한다.

#### evaluation date

검사 대상 candidate BOM 을 `X` 라 할 때:

| 상황 | evaluation date |
|---|---|
| 기본 | **`X.effectiveFrom`** |
| `POST …/activate` 가 `{effectiveFrom: T}` 를 지정 | **`T`** (요청 override 값) |
| header `PATCH` 가 `effectiveFrom` 을 바꿈 | **변경 후 `effectiveFrom`** |
| `POST /api/boms/import` | **각 imported header 의 `effectiveFrom`** |

★ **activate 에서 override 가 결정적이다.** D-7 이 historical 삽입과 future
activation 을 모두 허용하므로, approve 당시 cycle-free 였어도 `T` 가 달라지면
그 시점의 sibling 선택이 통째로 바뀐다. **approve 시점의 통과를 재사용하지 않는다.**

#### graph construction

```
buildCycleGraph(candidate X, evaluationDate D):
  # 1. candidate 의 parent 는 X 로 고정 — resolveEffectiveBom 을 쓰지 않는다.
  bomOf(X.parentSkuId) := X

  # 2. 그 밖의 parent SKU 는 D 시점의 유효 ACTIVE 버전 0/1건만.
  bomOf(otherSkuId)    := resolveEffectiveBom(otherSkuId, D)      # D-22 와 동일 predicate

  # 3. 같은 parent 의 다른 DRAFT / PENDING_APPROVAL / APPROVED / ACTIVE 버전은
  #    graph 에 넣지 않는다.
  # 4. bomOf(...) 가 null 인 SKU 는 leaf 다.
  # 5. candidate X 의 line set 은 **이번 mutation 이 반영된 이후 상태**를 쓴다.
  childrenOf(skuId) := bomOf(skuId)?.lines.map(l => l.componentSkuId) ?? []
```

| 규칙 | 확정 |
|---|---|
| candidate 의 parent | **X 를 강제 선택**. 같은 parent 의 다른 버전은 배제 |
| 그 밖의 parent | `resolveEffectiveBom(parentSkuId, D)` 로 **최대 1건** |
| 동일 parent 의 다른 버전 | ⛔ **동시 투입 금지** (DRAFT·PENDING·APPROVED·ACTIVE 무관) |
| 유효 BOM 0건인 SKU | **leaf** |
| candidate 의 line set | **mutation 반영 후** 상태 (같은 트랜잭션 안에서 읽는다) |
| 자식 판정 | `resolveEffectiveBom` 이 2건 이상을 만나면 **409 `BOM_EFFECTIVE_CONFLICT`** (D-22) — 순환 판정으로 감추지 않는다 |

★ candidate 가 `DRAFT` 여도 **자기 자신은 반드시 graph 에 들어간다.** 그래야
"입력 시점에 막는다"가 성립한다. 반면 **다른** SKU 의 DRAFT 는 들어가지 않는다 —
아직 발효되지 않은 남의 초안이 내 BOM 을 막을 이유가 없다.

#### ★ line → edge 포함 계약 (확정)

위 `childrenOf` 가 어떤 line 을 edge 로 삼는지를 명시한다.

> **선택된 BOM header 의 `BomLine` 에 `componentSkuId` 가 있으면, 그 line 은
> 예외 없이 cycle graph edge 다.**

순환은 "소요량을 계산할 수 있는가"가 아니라 **parent SKU → component SKU 의
구조적 참조 관계**이기 때문이다. 따라서 아래 속성은 **edge 필터 근거가 되지 않는다.**

| 속성 | 값 | edge |
|---|---|---|
| `isRequired` | `false` | **포함** |
| `componentRole` | `PRODUCT` · `MATERIAL` · `PACKAGING` · `SERVICE` | **전부 포함** |
| `supplyType` | `null` · `SELF_SUPPLIED` · `TURNKEY` | **전부 포함** |
| `alternateGroup` | `null` · 값 있음 | **전부 포함** |
| `quantityStatus` | `UNKNOWN` · `SUGGESTED` · `CONFIRMED` | **전부 포함** |
| `quantityPer` | `null` | **포함** |
| `lossRate` | `null` · 값 있음 | **포함** |
| 구성품 `Sku.inventoryManaged` | `false` | **포함** |

⛔ optional line 이라고 `A → B` 를 그래프에서 빼면 `B → A` 를 허용하게 된다.
두 line 이 모두 살아 있는 한 실물 구조는 순환이다.

⛔ **소요량 확정 여부(D-10 submit 게이트)와 순환 topology(D-13)는 서로 다른
계약이며 섞지 않는다.** `quantityStatus = UNKNOWN` 인 라인은 submit 을 막지만
graph edge 로서는 다른 라인과 완전히 동등하다.

⛔ 이 문서에 **line 단위 제외 규정은 없다.** 구현의 line 조회 `where` 는
`bomHeaderId` 하나뿐이어야 하며, 위 속성으로 거르는 조건을 추가하지 않는다.

#### DFS

**recursion-path(재귀 경로) 기반.** ⛔ 전역 `visited` 하나로 판정하지 않는다 —
그러면 **다이아몬드를 순환으로 오판**한다(`07v2:427` 이 다이아몬드를 "순환 아님"
으로 명시).

```
detectCycle(X, D):
  graph := buildCycleGraph(X, D)
  path  := []        # 현재 재귀 경로 — 순환 판정은 오직 이것으로 한다
  done  := Set()     # 이미 안전 확인된 노드 — 재방문 가지치기용, 판정에 미사용
  dfs(skuId, level):
    if skuId in path       -> BOM_CYCLE_DETECTED (path + skuId 를 오류에 포함)
    if skuId in done       -> return                # 다이아몬드: 순환 아님
    if level > MAX_LEVEL   -> BOM_MAX_LEVEL_EXCEEDED
    path.push(skuId)
    for child in graph.childrenOf(skuId):
      dfs(child, level + 1)
    path.pop()
    done.add(skuId)
  dfs(X.parentSkuId, 0)
```

`MAX_LEVEL = 10` (`05:132` explode 기본값과 **같은 상수를 공유**한다).

| 그래프 | 판정 |
|---|---|
| `A→B` · `A→C` · `B→D` · `C→D` (다이아몬드) | **정상** |
| `A→A` (직접 자기참조) | `BOM_CYCLE_DETECTED` |
| `A→B→A` | `BOM_CYCLE_DETECTED` |
| `A→B→C→A` | `BOM_CYCLE_DETECTED` |

★ **`A→A` 직접 자기참조도 이 검사가 함께 막는다.** D-12 의
`BOM_SELF_COMPONENT` 는 DTO 단계의 빠른 거부이고, DFS 는 같은 사실을 그래프
차원에서 다시 확인한다(두 방어를 모두 둔다).

#### 검사 시점

| 시점 | 검사 | evaluation date | 이유 |
|---|:-:|---|---|
| `POST …/lines` | ✅ | `X.effectiveFrom` | `05:122` 원문 명시 |
| `PATCH …/lines/{lid}` | ✅ | `X.effectiveFrom` | `componentSkuId` 를 바꿀 수 있다 |
| **`PATCH /api/boms/{id}`** | ✅ **(`effectiveFrom` 변경 시)** | **변경 후 값** | 날짜가 바뀌면 sibling 선택이 통째로 바뀐다 |
| `POST …/submit` | ✅ | `X.effectiveFrom` | 라인 추가 이후 다른 BOM 이 바뀌었을 수 있다 |
| **`POST …/activate`** | ✅ **(필수)** | **최종 `T`** | approve 시점 통과를 재사용하지 않는다 |
| `POST …/clone` | ✅ | 새 header 의 `effectiveFrom` | 아래 |
| `POST /api/boms/import` | ✅ | 각 header 의 `effectiveFrom` | header 마다 개별 candidate 로 검사 |

**`clone` 도 검사한다** (기존 결정 변경). clone 은 `05:130` 대로 **기존 라인
전체를 복제**하고 `newVersion`·`effectiveFrom` 을 새로 받으므로, **원본이
통과했던 evaluation date 와 다른 날짜**가 된다. 그 날짜의 sibling 조합에서는
순환일 수 있다. 복제가 끝난 뒤 **같은 트랜잭션 안에서** candidate graph 를
검사하고, 실패하면 **clone 전체를 rollback** 한다.

`import` 는 배치를 하나의 union graph 로 묶지 않는다. **imported header 마다
자기 `effectiveFrom` 을 evaluation date 로 삼아 개별 candidate 로 검사**한다.
같은 배치의 다른 header 는 저장된 뒤 `resolveEffectiveBom` 의 대상이 될 뿐이며,
전량 `DRAFT` 로 들어오므로(`06v2:268`) 서로의 그래프에 들어가지 않는다.

**DB 로는 막을 수 없다.** 위 경로 전부가 각각 검사하며, 동시성은 **D-28 의
`BOM_CYCLE_GRAPH` transaction advisory lock** 이 보장한다 — cycle graph 를
**읽기 전에** 그 lock 을 획득한다. ⛔ SKU 행 잠금만으로는 disjoint edge write
skew(`A→B` + `C→D` 에 `B→C`·`D→A` 동시 추가)를 막지 못한다(D-28 반례).

### D-14 — exact DTO

⛔ 공통 규칙: **`strictObject`** — unknown key 는 **400**. Decimal 은 전부
**십진 문자열**(JSON number 400). server-managed 필드는 요청에 있으면 **400**.

#### `CreateBomDto` (`POST /api/boms`)

```
{
  parentSkuId:            string (uuid)      required
  bomType:                'MANUFACTURING'|'KIT'|'REPACK'   required
  version:                string (1~20, trim)  required
  outputQty:              string (Decimal>0)   optional, default "1"
  outputUom:              string               optional → parent baseUom (D-11)
  effectiveFrom:          string (YYYY-MM-DD)  required
  effectiveTo:            string|null          optional
  productionPartnerId:    string (uuid)|null   optional
  destinationWarehouseId: string (uuid)|null   optional
  overallLossRate:        string (Decimal)|null optional
  description:            string|null          optional
  changeReason:           string|null          optional
}
```

⛔ reject: `status` · `createdBy` · `approvedAt/By` · `activatedAt` · `id` · `lines`
(라인은 별도 endpoint 로 만든다).

#### `UpdateBomDto` (`PATCH /api/boms/{id}`)

`CreateBomDto` 에서 **`parentSkuId` · `version` 을 뺀** 부분집합. 최소 1개 필드
필수(빈 body 400). ⛔ `parentSkuId`/`version` 변경 금지 — 다른 BOM 이 된다.

#### `CreateLineDto` (`POST /api/boms/{id}/lines`)

```
{
  lineNo:           number|null   optional → 생략 시 서버가 max+1
  componentSkuId:   string (uuid) required
  quantityPer:      string|null   optional (D-10)
  quantityStatus:   'CONFIRMED'|'SUGGESTED'|'UNKNOWN'  optional, default 'UNKNOWN'
  uom:              string        optional → 구성품 baseUom (D-11)
  lossRate:         string|null   optional
  componentRole:    'PRODUCT'|'MATERIAL'|'PACKAGING'|'SERVICE'  required
  supplyType:       'SELF_SUPPLIED'|'TURNKEY'|null  optional
  alternateGroup:   string|null   optional  // trim → blank 면 null 로 정규화 (D-3)
  isRequired:       boolean       optional, default true
  issueWarehouseId: string (uuid)|null optional
  packQuantity:     string|null   optional
  specification:    string|null   optional
  note:             string|null   optional
}
```

#### `UpdateLineDto` (`PATCH …/lines/{lid}`)

위에서 **`lineNo` 를 뺀** 부분집합. 최소 1개 필드 필수.
⛔ `bomHeaderId` 변경 금지(라인 이동 없음).

#### `BomDetail` (`GET /api/boms/{id}`)

```
{
  bom: {
    id, parentSkuId, parentSku: {id, skuCode, skuName},
    bomType, version, status,
    outputQty (string), outputUom,
    effectiveFrom, effectiveTo,
    productionPartnerId, productionPartner: {id, supplierCode, supplierName}|null,
    destinationWarehouseId,                    // ★ 이름 join 없음 (T08 미착수)
    overallLossRate (string|null),
    description, changeReason,
    createdAt, createdBy, approvedAt, approvedBy, activatedAt,
    lineCount, unconfirmedCount,               // 진행률 바용 (D-31)
    lines: BomLineView[]
  },
  requestId
}
```

`BomLineView` = **`BomLine` scalar 18 개 전부**(D-2·D-9) + `componentSku: {id, skuCode, skuName, baseUom}`.
⛔ 원가·전개 결과를 여기 섞지 않는다(각 endpoint 가 담당).

`GET /api/boms` 목록은 `lines` 없이 header + `lineCount`·`unconfirmedCount` 만
반환하고, 페이지 크기는 **서버 고정 50**(`SUPPLIER_PAGE_SIZE` 와 같은 규약)이다.
`pageSize` 쿼리를 받지 않는다.

#### ★ `GET /api/boms` 쿼리 계약 — T07-3 Recovery gap closure

⚠️ 아래 3건은 원문·D-31 에 **정의가 없어** T07-3 구현이 판단한 것을 이 문서가
**authoritative contract 로 승격**한 것이다. production behavior 변경은 없다.

##### ① `effectiveOn` 은 **period-only filter** 다 — status 를 함의하지 않는다

```
effectiveFrom <= D
AND (effectiveTo IS NULL OR D < effectiveTo)
```

D-5·D-22 와 **정확히 같은 반열림 `[from, to)`** predicate 이며, `status` 필터와
**독립적으로 AND** 조합된다.

| 요청 | 의미 |
|---|---|
| `?effectiveOn=2026-08-16` | 그 날짜에 기간상 걸리는 **모든 status** 의 BOM |
| `?effectiveOn=2026-08-16&status=ACTIVE` | 그 날짜에 기간상 걸리는 **ACTIVE** BOM |

⛔ `effectiveOn` 이 `status=ACTIVE` 를 암묵적으로 추가하지 **않는다.**

근거:
- D-7 이 **status 와 적용기간을 분리된 축**으로 확정했다
- `DRAFT`·`APPROVED` 도 적용기간을 갖는다 (D-5: `DRAFT` 도 `effectiveFrom` 필수)
- `status` 쿼리가 이미 별도로 존재한다
- `effectiveOn` 이 `ACTIVE` 를 강제하면 `?effectiveOn=X&status=DRAFT` 같은
  합법적 조합이 **항상 0건**이 되어 두 필터가 서로를 무효화한다

##### ② 목록 정렬은 **고정**이며 `version` 으로 정렬하지 않는다

```
1. parentSku.skuCode ASC
2. effectiveFrom     DESC
3. id                ASC        ← deterministic tie-breaker
```

⛔ `version` 문자열 정렬 금지 — client 가 주는 `VarChar(20)` 이고 semantic
version 파싱을 하지 않으며(D-4), **버전 시간 순서는 `effectiveFrom` 이 정한다.**
⛔ `sort` 쿼리를 추가하지 않는다.

##### ③ `hasUnknownQty` 는 `quantityStatus` 로 판정한다

| 값 | predicate |
|---|---|
| `true` | `EXISTS (line WHERE quantityStatus = 'UNKNOWN')` |
| `false` | `NOT EXISTS (line WHERE quantityStatus = 'UNKNOWN')` (라인 0건 BOM 포함) |

⛔ `quantityPer IS NULL` 로 판정하지 않는다 — D-10 이 두 값의 정합을 보장하지만
**필터의 근거는 상태 컬럼**이다.

⚠️ `hasUnknownQty` 와 `unconfirmedCount` 는 **서로 다른 것**이다:

| 이름 | 기준 | 근거 |
|---|---|---|
| `hasUnknownQty` | `quantityStatus = 'UNKNOWN'` 만 | 이름 그대로 · D-31 UX "① `UNKNOWN` 행 빨간 배경" |
| `unconfirmedCount` | `quantityStatus ≠ 'CONFIRMED'` (**`SUGGESTED` 포함**) | D-31 진행률 바 "확정 N / 전체 M" · D-10 "`SUGGESTED` 는 확정이 아니다" |

#### `ExplodedNode` (D-18)

```
{
  level:            number      // root=0
  path:             string[]    // 조상 skuId 배열 (순환 진단·경로 보존용)
  bomHeaderId:      string|null // leaf 는 null
  componentSkuId:   string
  componentSku:     {id, skuCode, skuName, baseUom}
  componentRole:    string
  quantityPer:      string|null
  lossRate:         string|null
  requiredQty:      string      // D-19 로 계산된 누적 소요량
  uom:              string
  isLeaf:           boolean
  quantityStatus:   string
}
```

#### `CostResult` (D-25·D-26·D-27)

```
{
  bomId, parentSkuId, asOf, requestedQty (string),
  isProvisional: boolean,
  provisionalReasons: ('QTY_UNCONFIRMED'|'NO_PRIMARY_SUPPLIER'|'NO_EFFECTIVE_PRICE')[],
  components: [{
    componentSkuId, componentSku: {id, skuCode, skuName},
    level, requiredQty (string), uom,
    supplierSkuId: string|null,
    unitPrice: string|null, currency: string|null, vatIncluded: boolean|null,
    lineCost: string|null,                    // requiredQty × unitPrice, null 이면 산정 불가
    provisionalReason: string|null
  }],
  subtotals: [{ currency, vatIncluded, amount (string) }],   // D-26·D-27
  requestId
}
```

⛔ **단일 `totalCost` 필드를 두지 않는다** — 통화·VAT 상태가 섞이면 하나의 수로
합칠 수 없기 때문이다(D-26·D-27).

### D-15 — permissions

신규 permission **5종**. `bom.cost` 를 **만들지 않는다.**

| key | 부여 role |
|---|---|
| `bom.read` | ADMIN · SCM_LEADER · SCM_STAFF · FINANCE · **EXECUTIVE** |
| `bom.create` | ADMIN · SCM_LEADER · SCM_STAFF |
| `bom.update` | ADMIN · SCM_LEADER · SCM_STAFF |
| `bom.submit` | ADMIN · SCM_LEADER · SCM_STAFF |
| `bom.approve` | ADMIN · SCM_LEADER |

★ **EXECUTIVE 가 BOM 을 읽는다.** `05v2:661` 이 `BOM 목록·상세 | RW RW RW R **R**`
로 명시하며, 이는 `거래처·공급조건`(E = —)과 **정반대**다. T1-6B4 에서 ⑥ 공급조건
탭을 EXECUTIVE 에게 숨긴 것과 달리 **⑦ BOM 탭은 보여야 한다.**

★ **FINANCE 는 BOM mutation 권한이 없다**(`05v2:661-662` R / —).

**`cost` 는 `bom.read` 로 판정한다.** 근거: ① `05:133` 의 `전체+F` 는 T06-3 에서
이미 모순 표기로 판정된 형식이고, ② 화면 권한표에 **BOM 원가 행이 아예 없어**
별도 key 를 만들 근거가 없으며, ③ `05v2:661` 이 BOM 목록·상세 read 를 F·E 에게
이미 주었으므로 `전체+F` 가 의도한 집합(F 포함)이 `bom.read` 와 같다.
원가만 따로 숨겨야 할 요구가 생기면 그때 `bom.cost` 를 추가한다.

**`activate`/`deactivate`/`archive` 는 `bom.approve`** 다. `05v2:158-159` 가
활성화·사용종료를 `L,A` 로 두어 approve 와 같은 집합이며, 별도 key 로 나눌
근거가 없다.

#### route-policy (proxy 1차 가드)

⛔ 현재 `/api/boms*` 는 정책이 **없어 인증만으로 통과**하고,
`/api/skus/{id}/where-used` 는 일반 `/api/skus` 정책에 잡혀 **`sku.read`** 로
shadow 된다(T1-6B4 `supplier-skus` 와 같은 상황). specific-before-general 로 넣는다.

```
// ── /api/skus 일반 정책보다 반드시 앞 ──
{ prefix:'/api/skus', contains:'/where-used', methods:['GET','HEAD'], permission:'bom.read' }

// ── /api/boms — suffix 지정이 일반 정책보다 앞 ──
{ prefix:'/api/boms', suffix:'/submit',     methods:['POST'], permission:'bom.submit'  }
{ prefix:'/api/boms', suffix:'/approve',    methods:['POST'], permission:'bom.approve' }
{ prefix:'/api/boms', suffix:'/reject',     methods:['POST'], permission:'bom.approve' }
{ prefix:'/api/boms', suffix:'/activate',   methods:['POST'], permission:'bom.approve' }
{ prefix:'/api/boms', suffix:'/deactivate', methods:['POST'], permission:'bom.approve' }
{ prefix:'/api/boms', suffix:'/archive',    methods:['POST'], permission:'bom.approve' }
{ prefix:'/api/boms', suffix:'/clone',      methods:['POST'], permission:'bom.create'  }
{ prefix:'/api/boms', contains:'/lines',    methods:['POST'],                    permission:'bom.update' }
{ prefix:'/api/boms', contains:'/lines',    methods:['PATCH','PUT','DELETE'],    permission:'bom.update' }
{ prefix:'/api/boms', methods:['GET','HEAD'],          permission:'bom.read'   }
{ prefix:'/api/boms', methods:['POST'],                permission:'bom.create' }
{ prefix:'/api/boms', methods:['PATCH','PUT','DELETE'],permission:'bom.update' }

// ── 화면 ──
{ prefix:'/master/boms', methods:['GET','HEAD'], permission:'bom.read' }
```

`…/lines/bulk-confirm-qty` 는 `contains:'/lines'` + POST 로 `bom.update` 에
잡힌다(의도된 결과). `POST /api/boms/import` 는 T07-8 유예이므로 지금 넣지 않는다.

#### ★★ RESERVED POLICY — T07-3 이 등록하되 endpoint 는 만들지 않는다

T07-3 은 위 13개 정책을 **전부** 등록한다. 그중 **8개는 아직 존재하지 않는
endpoint·화면을 위한 예약**이다.

| 예약 정책 | 대상 Task | permission |
|---|---|---|
| `suffix:'/submit'` | T07-5 | `bom.submit` |
| `suffix:'/approve'` | T07-5 | `bom.approve` |
| `suffix:'/reject'` | T07-5 | `bom.approve` |
| `suffix:'/activate'` | T07-5 | `bom.approve` |
| `suffix:'/deactivate'` | T07-5 | `bom.approve` |
| `suffix:'/archive'` | T07-5 | `bom.approve` |
| `suffix:'/clone'` | T07-5 | `bom.create` |
| `prefix:'/master/boms'` | T07-8 | `bom.read` |

**왜 endpoint 보다 먼저 등록하는가**

1. T07-3 이 일반 `{prefix:'/api/boms', methods:['POST']}` 규칙을 **처음 도입**한다.
2. `resolveRoutePermission` 은 **첫 일치 우선**이다.
3. 따라서 예약이 없으면, T07-5 가 `…/submit` 을 만드는 순간 그 요청이
   **`bom.create` 로 잡혀** 승인 통제가 무너진다 — T07-3 이 만든 규칙 때문에
   생기는 구멍이므로 T07-3 이 함께 닫는다.
4. `/master/boms` 도 마찬가지다 — 표에 없는 경로의 기본값은 "인증만 요구"이므로,
   화면이 생기는 순간 `bom.read` 없이 열린다.
5. permission matrix(D-15)는 이미 확정돼 있어 예약 값이 흔들릴 여지가 없다.

**이것이 아닌 것**

⛔ endpoint 구현이 **아니다** — route handler 는 **0개**이고 해당 경로는 여전히
**404** 다. T07-5·T07-8 의 구현 완료로 간주하지 않는다.
⛔ 예약 정책은 새 permission 을 만들지 않는다 — D-15 의 5종만 쓴다.

**application 2차 가드**(`assertPermission`)를 route 마다 반드시 둔다.
⛔ ADMIN bypass 없음 — RolePermission 데이터로만 판정한다.

### D-16 — audit

`02:339` 가 **"SKU·BOM 승인/변경"** 을 감사 대상으로 명시한다.

| entityType | action | 대상 |
|---|---|---|
| `BomHeader` | `CREATE` | 생성 · clone |
| `BomHeader` | `UPDATE` | PATCH (실변경 시에만) |
| `BomHeader` | `SUBMIT` | 승인 요청 |
| `BomHeader` | `APPROVE` | 승인 (`approvedBy` 채움) |
| `BomHeader` | `REJECT` | 반려 (`reason` 필수) |
| `BomHeader` | **`ACTIVATE`** | 활성화 — **신규 action** |
| `BomHeader` | `DEACTIVATE` | 사용종료 |
| `BomHeader` | `UPDATE` | ★ **predecessor 기간 마감** (D-7 5단계, 실변경 시) |
| `BomLine` | `CREATE`·`UPDATE`·`DELETE` | 라인 개별 변경 |

**신규 action 문자열은 `ACTIVATE` 하나**다. `AuditLog.action` 은 `String` 이라
enum 변경이 필요 없다.

**`CLONE` action 을 만들지 않는다.** clone 의 결과물은 새 `BomHeader` 이므로
`CREATE` 로 남기고 `reason` 에 `changeReason` 을, `afterValue` 에 원본
`sourceBomId` 를 담는다. 새 어휘를 늘리지 않는다.

**`bulk-confirm-qty` 는 라인마다 audit 을 만들지 않는다.** 383행이면 383건이
쌓여 이력이 무의미해진다. 대신 **`BomHeader` 에 `UPDATE` 1건**을 남기고
`afterValue` 에 `{confirmedLineCount, lineIds}` 요약을 담는다.
(일반 line PATCH 는 개별 audit 을 유지한다 — 사람이 한 건씩 고치는 행위다.)

audit write 는 **business write 와 같은 트랜잭션**이다(기존 규약).
SKU 변경이력 화면의 `SKU_HISTORY_ENTITY_TYPES` 는 **이번에 바꾸지 않는다** —
BOM 이력은 BOM 상세의 `변경이력` 탭(D-31)이 담당한다.

### D-17 — idempotency

멱등 계약을 갖는 endpoint **5개**(`05v2 §10.8` ✅ 표기 그대로). 기존 공용
`executeWithIdempotency` 를 재사용하며 **새 framework 를 만들지 않는다.**

| endpoint | routeScope | repeat 시 |
|---|---|---|
| `POST /api/boms` | `bom:create` | 저장된 snapshot 재반환 |
| `POST /api/boms/{id}/lines` | `bom:{bomId}:line:create` | 저장된 snapshot 재반환 |
| `POST /api/boms/{id}/lines/bulk-confirm-qty` | `bom:{bomId}:line:bulk-confirm` | 저장된 snapshot 재반환 |
| `POST /api/boms/{id}/clone` | `bom:{bomId}:clone` | 저장된 snapshot 재반환 |
| `POST /api/boms/import` | (T07-8 유예) | — |

scope 에 **실제 `bomId` 를 포함**한다(T06-3 가 `supplierSkuId` 를 포함한 것과 동일)
— 서로 다른 BOM 에 같은 키를 써도 충돌하지 않아야 한다.

**workflow action(submit/approve/reject/activate/deactivate/archive)에는 멱등 키가
없다.** 자연 멱등이며, 이미 목표 상태면 **200 no-op**(write 0 · audit 0)이다.
`PATCH`·`DELETE`·모든 `GET` 도 멱등 키를 받지 않는다(있으면 400).

### D-18 — explode semantics

`GET /api/boms/{id}/explode?qty=&asOf=&maxLevel=`

| 항목 | 확정 |
|---|---|
| root | **요청한 BOM header 자체**(SKU 가 아니다). root 는 asOf 로 재선택하지 않는다 |
| `qty` | Decimal 문자열, `> 0`, **기본 `"1"`** |
| `asOf` | `YYYY-MM-DD`, **기본 = 서버 업무일자**(D-21) |
| `maxLevel` | 정수 `1..10`, **기본 10**. 범위 밖 400 |
| 하위 BOM 선택 | **`resolveEffectiveBom(componentSkuId, asOf)`** (D-22) |
| leaf | 해당 asOf 에 유효한 ACTIVE BOM 이 **없는** 구성품 |
| 중간 노드 | **결과에 포함한다** (`isLeaf=false`). 반제품 자체도 소요 대상이다 |
| `maxLevel` 초과 | **422 `BOM_MAX_LEVEL_EXCEEDED`**. ⛔ 조용히 절단하지 않는다 |
| 순환 발견 | **422 `BOM_CYCLE_DETECTED`** (경로 포함) |
| ordering | `level` asc → 같은 level 내 부모의 `lineNo` asc → `lineNo` asc |
| 응답 | `ExplodedNode[]` — **평면 배열** + `level`·`path` 로 트리 복원 |

중간 노드를 포함하는 근거: `01:192` 가 `완제품 → 반제품(벌크) → 부자재` 를
실제 구조로 확인했고, 반제품은 **그 자체로 재고 SKU** 다. 빼면 조립 소요를
계산할 수 없다. 소비자는 `isLeaf` 로 필요한 쪽을 고른다.

`componentRole = SERVICE` 라인도 그대로 포함한다(`inventoryManaged=false` 여도
원가에는 들어간다 — 임가공비 464원).

### D-19 — quantity formula ★

⛔ 원문에 계산식이 **한 줄도 없다.** 아래는 이 Recovery 가 확정하는 계약이며,
`07:118`(박스 단가 = 가격÷입수량) · TC-BOM-003(`pack=30 → qty=1/30`) ·
`05:391`("실제 필요량(계산)") 세 파편과 정합하도록 정했다.

#### 정의

| 기호 | 출처 |
|---|---|
| `Q` | 요청 수량 (`explode.qty` · `cost.qty`) |
| `outputQty` | `BomHeader.outputQty` — 이 BOM 1회 실행의 **산출 수량** |
| `quantityPer` | `BomLine.quantityPer` — **`outputQty` 만큼 만들 때** 필요한 구성품 수량 |
| `lossRate` | `BomLine.lossRate` — 라인 손실률 |
| `overallLossRate` | `BomHeader.overallLossRate` — BOM 전체 손실률 |

#### 공식

```
scale        = Q / outputQty
requiredQty  = scale × quantityPer × (1 + lossRate) × (1 + overallLossRate)
```

다단계에서는 부모의 `requiredQty` 가 자식의 `Q` 가 된다:

```
requiredQty(child) = requiredQty(parent)
                     / outputQty(childBom)
                     × quantityPer(childLine)
                     × (1 + lossRate(childLine))
                     × (1 + overallLossRate(childBom))
```

#### 손실률 해석 — **가산식** 확정

`lossRate = 0.05` 는 **5% 를 더 투입한다**는 뜻이다 (`× 1.05`).

⛔ **수율식 `1 / (1 - lossRate)` 을 쓰지 않는다.** 근거:
① 필드 이름이 `lossRate` 이지 `yield` 가 아니다.
② `1/(1-x)` 는 `x → 1` 에서 발산하는데 DB 에 `x < 1` CHECK 가 없다
   (D-9 가 DTO 에서만 막는다).
③ `Decimal(8,6)` 은 최대 `99.999999` 까지 담을 수 있어 비율 상한을 전제하지 않는다.
가산식이 정의역 전체에서 안전하고 해석이 단순하다.

`lossRate`/`overallLossRate` 가 `null` 이면 **`0`** 으로 본다 (`× 1`).
⛔ `null` 을 "미입력이므로 추정"하지 않는다 (`01:190` "로스율·수율 부재 →
`loss_rate` nullable, 기본 0, **임의 추정 금지**").

#### 원가 단가 — `packQuantity` 의 자리

`07:118` 의 **박스 단가 = 가격 ÷ 입수량** 은 **소요량 계산이 아니라 단가 환산**
이다. 그러나 D-11 에 따라 `quantityPer` 는 **구성품 baseUom 기준**이고
`SupplierSkuPrice.unitPrice` 도 그 SKU 의 가격이므로, **원가 계산에서
`packQuantity` 로 나누지 않는다.**

> `packQuantity` 는 **UI 추천값 생성(`1 ÷ packQuantity`)에만** 쓰인다.
> `1/30 EA` 라는 `quantityPer` 자체에 박스 환산이 이미 반영돼 있으므로,
> 원가에서 다시 나누면 **이중 환산**이 된다.

즉 `07:118` 의 "박스 단가" 는 `quantityPer = 1/packQuantity` 인 라인에서
`lineCost = (1/30) × unitPrice = unitPrice ÷ 30` 이 **자동으로 성립**하는 것을
서술한 것이며, 별도 나눗셈이 아니다. → `SUPERSEDED BY docs/18 §D-19` 로 명시.

#### precision · rounding

| 단계 | 규칙 |
|---|---|
| 중간 연산 | `src/shared/decimal` context 의 전체 정밀도. ⛔ 단계마다 반올림하지 않는다 |
| `requiredQty` 최종 | **소수점 6자리**, `ROUND_HALF_UP` (`Decimal(18,6)` 과 일치) |
| `lineCost`·`subtotal` | **소수점 4자리**, `ROUND_HALF_UP` (`Decimal(18,4)` 과 일치) |
| API 표현 | 전부 **문자열**. ⛔ `Number()`/`parseFloat()` 금지 |

★ **`0.033333 × 30 = 0.99999 ≠ 1` 을 재정규화하지 않는다.** 원본이 소요량을
`1/입수량` 으로 갖는 이상 이 오차는 데이터의 성질이며, 보정하면 사용자가 확정한
값을 서버가 바꾸는 것이 된다. 정확히 1 이 필요하면 사용자가 `quantityPer` 를
직접 확정한다(그래서 추천값이 `SUGGESTED` 가 아니라 사람의 수락을 요구한다).

#### 미래 의존성

이 공식은 **R1a-2 의 `ASSEMBLY`/`DISASSEMBLY` conservation 검증 기준**이 된다
(`PENDING #5` — *"조립지시서 + BOM 기준 검증"*). 나중에 바꾸면 원장 검증까지
영향을 받으므로, 변경 시 반드시 `PENDING #5` 와 함께 재검토한다.

### D-20 — aggregation

| 항목 | 확정 |
|---|---|
| `explode` 응답 | **경로별 detail 을 그대로 보존**한다. 합산하지 않는다 |
| `cost` 응답 | `components[]` 는 **`(componentSkuId, uom)` 단위로 합산**한다 |
| 합산 키 | `componentSkuId` + `uom`. D-11 에 의해 한 SKU 의 `uom` 은 항상 `baseUom` 이므로 **실질적으로 SKU 단위 합산**이 된다 |
| UOM 이 다르면 | 합산 금지 → 별도 행. (D-11 하에서는 발생하지 않지만 방어적으로 규정) |
| 다이아몬드 | 합산된다. **순환이 아니다** (`07v2:427`) |
| `level` 표기 | 합산 행의 `level` 은 **등장한 최소 level** |

`explode` 는 "어떻게 구성되는가"(구조)를, `cost` 는 "얼마가 드는가"(총량)를
답하므로 정책이 다르다. 둘 다 필요한 화면은 두 endpoint 를 각각 호출한다.
⛔ 한 endpoint 가 detail 과 aggregate 를 동시에 반환하지 않는다.

### D-21 — asOf

> **한 request 안에서 `effective BOM` · `SupplierSku` · `SupplierSkuPrice` 는
> 반드시 같은 `asOf` 를 쓴다.** request 시작 시 한 번 확정해 전 계층에 전달한다.

| 항목 | 확정 |
|---|---|
| 기본값 | `businessDateOf(new Date())` — **Asia/Seoul 업무일자** (`src/shared/business-date.ts`) |
| `explode` | `asOf` **optional**, 생략 시 기본값 |
| `cost` | `asOf` **optional**, 생략 시 기본값 — ★ `05:133` 의 required 표기를 좁게 supersede |
| 형식 | `YYYY-MM-DD`. 형식 오류 400 |
| 미래·과거 | 제한 없음 |
| UI | BOM 상세 원가 탭은 **기준일 선택**을 제공하고(`05v2:494`) 기본값을 오늘로 채운다 |

`cost` 를 optional 로 통일하는 근거: ① `explode` 와 불일치하면 두 탭이 서로 다른
기준일로 보이는 사고가 난다, ② T1-6B4 가 확립한 **request-scoped 업무일자**
규약이 이미 있다, ③ required 로 두면 화면이 매번 날짜를 만들어 보내야 해서
클라이언트가 기준일을 정하는 주체가 된다.
⛔ 단, T1-6B4 ⑥ 탭처럼 **asOf 입력 UI 를 아예 없애지는 않는다** — BOM 원가 탭은
`05v2:494` 가 기준일 선택을 명시한다.

### D-22 — `resolveEffectiveBom`

**internal domain resolver 로 확정한다. REST 전용으로 만들지 않는다.**
T06-3 의 `resolveEffectiveSupplierPrice` 가 T07·T1-6B4 에 재사용된 것과 같은 구조다.

```ts
resolveEffectiveBom(db, { parentSkuId, asOf }): Promise<BomHeaderRow | null>
resolveEffectiveBoms(db, { parentSkuIds, asOf }): Promise<Map<string, BomHeaderRow | null>>
```

predicate:

```
status = 'ACTIVE'
AND effectiveFrom <= asOf
AND (effectiveTo IS NULL OR asOf < effectiveTo)
```

| candidate | 결과 |
|---|---|
| 0건 | **`null`** — "이 SKU 에는 현재 유효한 BOM 이 없다". 오류가 아니다 |
| 1건 | 해당 header |
| **2건 이상** | **409 `BOM_EFFECTIVE_CONFLICT`** — EXCLUDE 가 있으므로 발생하면 데이터 손상이다. ⛔ `LIMIT 1` 로 숨기지 않는다 |

배치 버전은 **`IN (...)` 단일 쿼리**로 N+1 을 만들지 않는다(T1-6B4
`resolveEffectiveSupplierPrices` 와 같은 방식). 단건은 배치의 1-id wrapper 로
두어 semantics 를 한 군데에 모은다.

**T07-2(도메인)에 둔다.** 소비자: **`cycle` graph 구성(D-13)** · `explode`(D-18) ·
`cost`(D-23) · `where-used` ·
T1-6B5 · 향후 WO/assembly.

### D-23 — SupplierSku selection ★

⛔ **어느 문서에도 규칙이 없다.** 이 Recovery 가 확정한다.

> BOM 원가에서 한 구성품 SKU 의 공급조건은
> **asOf 에 유효하고 `isPrimary = true` 인 `SupplierSku` 하나**를 쓴다.

```
status  : (SupplierSku 에는 status 컬럼이 없다)
predicate:
  skuId = :componentSkuId
  AND isPrimary = true
  AND effectiveFrom <= asOf
  AND (effectiveTo IS NULL OR asOf < effectiveTo)
```

| candidate | 결과 |
|---|---|
| 0건 | `supplierSkuId = null` · `unitPrice = null` · `provisionalReason = 'NO_PRIMARY_SUPPLIER'` → **provisional**. ⛔ 오류 아님. ⛔ **0원 대체 절대 금지** |
| 1건 | 사용 |
| **2건 이상** | **409 `BOM_SUPPLIER_SELECTION_CONFLICT`** — 데이터 손상 |

**근거**: `supplier_sku` 에 조건부 `UNIQUE(sku_id) WHERE is_primary=true AND
effective_to IS NULL` 이 **실제로 구현돼 있어**(`20260812010000` migration:236)
현행 대표 공급조건의 유일성이 DB 로 보장된다. 다른 후보(최저가·명시 입력)는
문서 근거가 전혀 없고, 최저가 선택은 통화 혼재(D-26)에서 비교 자체가 불가능하다.

⚠️ **위 partial unique 는 `effective_to IS NULL` 인 행만 덮는다.** 과거 asOf 를
조회하면 이미 종료된 대표 행이 여럿 걸릴 수 있으므로 **2건 이상 분기가 실제로
필요하다.** 이것이 `LIMIT 1` 을 쓰지 않는 이유다.

**`Supplier.status` 로 자동 필터링하지 않는다.** 별도 근거가 없고, 거래처가
`INACTIVE` 라도 과거 시점 원가는 그 거래처 가격으로 계산되는 것이 맞다.

★ T1-6B4 의 `listSkuSupplierSummaries` 는 **요약 목록**(현재 유효 공급조건 전부
나열)이라 이 선택 문제를 풀지 않았다. 재사용하지 말고 별도 resolver 를 둔다.

### D-24 — price resolver

SupplierSku 선택 후에는 **기존 resolver 를 그대로 재사용한다.**
`07:104` 가 *"resolver 는 `resolveEffectiveSupplierPrice` 로 분리해 **T07-7 BOM
원가**·T1-6B4 최근 단가가 재사용한다"* 로 이미 확정했다.

```ts
resolveEffectiveSupplierPrices(db, { supplierSkuIds, asOf })
```

| candidate | 결과 |
|---|---|
| 0건 | `unitPrice = null` · `provisionalReason = 'NO_EFFECTIVE_PRICE'` → provisional. ⛔ **0원 대체 금지** |
| 1건 | 사용 (`unitPrice`·`currency`·`vatIncluded`) |
| **2건 이상** | **409 `SUPPLIER_PRICE_CHAIN_CONFLICT`** (기존 코드) |

**chain conflict 를 provisional 로 낮추지 않는다.** 가격 없음은 "아직 정보가
없다"이지만 chain 손상은 "데이터가 틀렸다"이다. 후자를 잠정 표시로 감추면
사용자가 잘못된 원가를 신뢰한다. **whole-request 409** 를 유지한다 —
T06-3·T1-6B4 와 같은 판단이다.

⛔ **미승인(pending) 가격은 절대 잡히지 않는다** (`approvedBy IS NOT NULL`).
⛔ BOM 라인에 단가를 고정 저장하지 않는다 (`02:482①`, `01:194`, `01:506`).
⛔ 최신 생성 가격을 따로 조회하지 않는다 — asOf 유효 가격만 쓴다.

### D-25 — provisional

`isProvisional` 의 exact 정의:

> `components[]` 중 **하나라도** 아래에 해당하면 `isProvisional = true`.

| reason | 조건 |
|---|---|
| `QTY_UNCONFIRMED` | `isRequired=true` 라인의 `quantityStatus ≠ CONFIRMED` |
| `NO_PRIMARY_SUPPLIER` | D-23 에서 0건 |
| `NO_EFFECTIVE_PRICE` | D-24 에서 0건 |

`provisionalReasons[]` 에 **발생한 사유 종류**를 중복 없이 담고, 각 component 행에
`provisionalReason` 을 개별로 남긴다.

| 항목 | 확정 |
|---|---|
| `lineCost` | 산정 불가한 component 는 **`null`**. ⛔ 0 으로 채우지 않는다 |
| `subtotals` | **산정 가능한 component 만** 합산한다 (known partial sum) |
| 단일 `totalCost` | ⛔ **필드 자체를 두지 않는다** (D-26) |
| 데이터 손상 | ⛔ **provisional 로 숨기지 않는다** — chain conflict·selection conflict·effective BOM conflict 는 전부 **409** |
| **0원 가격** | **정상 가격이며 provisional 이 아니다.** `unitPrice="0"` → `lineCost="0.0000"` (T06-3 D-3 와 동일) |

`QTY_UNCONFIRMED` 를 포함하는 근거: 383행이 전량 `UNKNOWN` 으로 이관되므로
(`06v2:253`) 실무상 이 사유가 지배적이며, `05v2:494` 의 `잠정` 배지가 원가 탭에
붙는 목적이 정확히 이 상태를 알리는 것이다. 소요량이 미확정이면 원가는 계산조차
할 수 없다(`quantityPer` 가 null) → `lineCost = null`.

### D-26 — currency ★

**환율 subsystem 이 저장소에 존재하지 않는다.** `03v2` 47테이블·`SystemSetting`
어디에도 환율이 없고, `01:137` 의 `수입단가` 시트(수입 부자재 30행)가 가격이력
후보이므로 **비KRW 가 실제로 유입된다.** F-18(랜딩코스트)은 R2 후속으로 유예돼
있다.

> **`CostResult` 는 단일 총액을 반환하지 않는다.**
> `subtotals[]` 를 **`(currency, vatIncluded)` 조합별로** 반환한다.

```json
"subtotals": [
  { "currency": "KRW", "vatIncluded": false, "amount": "12345.6700" },
  { "currency": "USD", "vatIncluded": false, "amount": "12.3400" }
]
```

| 항목 | 확정 |
|---|---|
| 통화 혼재 | **오류가 아니다.** 정상적으로 subtotal 이 나뉜다 |
| 환산 | ⛔ **절대 금지.** 임의 KRW 환산·고정 환율·근사 모두 금지 |
| 정렬 | `currency` asc → `vatIncluded` false 먼저 |
| 0건 | 산정 가능한 component 가 하나도 없으면 `subtotals: []` |
| UI | 통화별 subtotal 을 **각각 표시**한다. 합계 한 줄로 만들지 않는다 |

`05:133` 의 `CostResult` 는 필드 정의가 없으므로 이 형태와 충돌하지 않는다.
`05v2:481` BOM 목록의 **`기준원가`** 열은 통화가 섞이면 단일 값으로 표시할 수
없으므로 **KRW subtotal 만** 보여주고 다른 통화가 있으면 `+` 표식을 붙인다(D-31).

### D-27 — VAT

환율과 같은 원칙이다.

> **저장된 승인 `unitPrice` 를 그대로 사용한다.** `vatIncluded` 를 근거로
> 10% 를 가감하지 않는다.

| 항목 | 확정 |
|---|---|
| 정규화 | ⛔ **금지.** T06-3 이 "VAT normalize 계산을 발명하지 않는다"를 이미 결정했다 |
| 합산 | `vatIncluded` 가 다르면 **다른 subtotal** 로 분리 (D-26 의 grouping key) |
| component 행 | `vatIncluded` 를 그대로 노출한다 |
| 세율 | ⛔ 어디에도 저장하지 않는다 |

근거: `01:135` 가 원본 `최종 BOM` 시트를 **"재고원가 요약(VAT별도/포함)"** 으로,
`01:148` V/W 열을 **"최근 매입가(VAT별도)"** 로 기록해 **두 형태가 실제로 공존**
한다. 세율을 시스템이 알지 못하는 상태에서 정규화하면 조용히 틀린 원가가 나온다.

### D-28 — concurrency

#### ⛔ 폐기된 계약 — endpoint row lock 만으로는 순환을 막을 수 없다

이 문서의 이전 판은 *"이번 write 가 edge 를 추가·변경하는 두 끝점(parent ·
component)만 `sku.id` ASC `FOR UPDATE` 하면, 순환을 공동으로 만드는 두
트랜잭션은 **반드시 공통 SKU 를 공유**하므로 충돌이 검출된다"* 고 했다.
**이 명제는 거짓이다.** 폐기한다.

**반례 — disjoint lock set 으로 만들어지는 장주기 순환**

기존 그래프:

```
A → B
C → D
```

동시 실행:

| | 추가하는 edge | lock set | 각자 읽은 그래프 | 각자 판정 |
|---|---|---|---|---|
| **TX1** | `B → C` | `{B, C}` | `A→B→C` · `C→D` | cycle 없음 ✅ |
| **TX2** | `D → A` | `{D, A}` | `C→D→A→B` | cycle 없음 ✅ |

두 lock set `{B,C}` 와 `{D,A}` 는 **완전히 disjoint** 하므로 서로 대기하지
않는다. 각자 상대의 미커밋 edge 를 보지 못한 채 통과하고, 둘 다 커밋되면

```
A → B → C → D → A
```

**순환이 생긴다.** 2-node 상호 경쟁(`A→B` vs `B→A`)은 공통 노드를 공유해서
막히지만, **서로 다른 edge 두 개가 합쳐져 장주기 순환을 만드는 write skew** 는
행 잠금으로 막을 수 없다. 순환 판정은 **그래프 전역 속성**이라 국소 잠금으로
직렬화되지 않기 때문이다.

##### ⚠️ 정정 — `Serializable` 에 대한 서술 (T07-2 remediation)

> **⛔ 폐기된 서술 (원문 보존, 더 이상 근거로 쓰지 않는다)**
>
> *"`isolationLevel: 'Serializable'` 로 올리는 것도 답이 아니다. 두 트랜잭션이
> 읽은 행 집합이 겹치지 않으면 predicate lock 이 잡히지 않을 수 있고, 잡히더라도
> 직렬화 실패(`40001`)가 사용자에게 그대로 노출되어 재시도 계약을 따로 설계해야
> 한다. 무엇보다 `withTransaction` 주석이 "재고 검증에 `Serializable` 을 쓰면
> 직렬화 실패가 늘어난다" 는 이유로 이 프로젝트는 `ReadCommitted` 를 기본으로
> 쓰고 있다."*
>
> ❌ **부정확한 부분**: "읽은 행 집합이 겹치지 않으면 predicate lock 이 잡히지
> 않을 수 있다" 는 PostgreSQL `SERIALIZABLE` 에 대한 일반적 설명으로 옳지 않다.

**정정된 근거 (확정)**

PostgreSQL 의 `SERIALIZABLE` 은 SSI(Serializable Snapshot Isolation)를 사용하며
**write skew 를 포함한 serialization anomaly 를 감지할 수 있다.** 위 disjoint-edge
경쟁에서도 serialization failure 가 발생할 수 있다. 즉 `SERIALIZABLE` 이 이
문제를 **막지 못하는 것이 아니다.**

`SERIALIZABLE` 을 채택하지 않은 실제 이유는 **도입 비용**이다.

| # | 이유 |
|---|---|
| 1 | 직렬화 실패(`40001`) 가 발생할 수 있어 **application 전역 retry contract** 를 따로 설계·검증해야 한다 |
| 2 | 현재 `withTransaction` 은 `ReadCommitted` 를 기본으로 한다. cycle 정합성 하나 때문에 transaction isolation 을 바꾸면 무관한 경로까지 재시도 semantics 를 갖는다 |
| 3 | BOM 편집은 **저빈도 경로**다 (실측 헤더 80 / 라인 383) |

→ 두 방식 모두 정합성을 얻을 수 있으나, 현재 architecture 에서는 **이 경로에
한정된 명시적·결정적(deterministic) transaction advisory lock** 이 더 단순하다.
따라서 BOM cycle graph mutation 에는 `BOM_CYCLE_GRAPH` advisory lock 을 채택한다.
**결론(advisory lock 채택)은 변경되지 않으며, 근거 문장만 정정한다.**

#### 확정 계약 — graph mutation advisory lock ★

> **BOM cycle 그래프에 영향을 줄 수 있는 모든 mutation 은, cycle graph 를
> 읽기 전에 하나의 공통 transaction-scoped advisory lock 을 획득한다.**

```sql
SELECT pg_advisory_xact_lock(:BOM_CYCLE_GRAPH_LOCK_KEY);
```

| 항목 | 확정 |
|---|---|
| 종류 | **`pg_advisory_xact_lock`** — transaction-scoped. ⛔ `pg_advisory_lock`(session lock) **금지** |
| 해제 | 트랜잭션 종료 시 **자동**. ⛔ 명시적 unlock 호출 없음(누수 불가) |
| 범위 | **고정 key 1개**. SKU·BOM 별로 쪼개지 않는다 — 쪼개면 위 반례가 그대로 남는다 |
| key 관리 | production code 의 **named constant**(예: `BOM_CYCLE_GRAPH_LOCK_KEY`)로 한 곳에서 관리. 정확한 numeric value 는 구현 시 확정하되, 다른 advisory lock namespace 와 충돌하지 않도록 프로젝트 상수 파일에 모은다 |
| 획득 시점 | **cycle graph read 이전**. ⛔ graph 를 먼저 읽고 나중에 잠그는 순서 금지 |
| 검증·write | **같은 트랜잭션** 안에서 수행 |

**직렬화 비용을 감수하는 근거**: BOM 편집은 재고 Posting 같은 초고빈도 경로가
아니다. 실측 규모는 **헤더 80 / 라인 383**(`01 §2.3`)이고 소요량 확정도 사람이
하는 작업이다. 순환 없는 그래프라는 correctness 를 국소 잠금으로는 얻을 수
없으므로, 이 정도 전역 직렬화는 합리적인 교환이다.

#### lock acquisition order

cycle-affecting operation 은 **정확히 이 순서**를 따른다.

```
1. DB transaction 시작
2. pg_advisory_xact_lock(BOM_CYCLE_GRAPH_LOCK_KEY)      ← ★ 가장 먼저
3. 필요한 SKU / bom_header row lock 을 deterministic order 로 획득
   (sku.id ASC → bom_header.id ASC)
4. evaluation date 확정 (D-13)
5. cycle graph read / build
6. DFS validation
7. business write
8. audit
9. commit  → advisory lock 자동 해제
```

⛔ **2단계보다 앞에서 graph 를 읽지 않는다.** 위 반례의 TX1·TX2 는 2단계에서
직렬화되므로, 뒤에 들어온 트랜잭션은 5단계에서 **상대의 커밋 결과가 반영된
그래프**를 읽고 `BOM_CYCLE_DETECTED` 로 실패한다.

advisory lock 은 항상 **가장 먼저** 잡으므로 row lock 과의 사이에 deadlock 이
생기지 않는다(모든 cycle-affecting 트랜잭션이 같은 첫 자원을 기다린다).

#### SKU / header row lock 의 역할

기존 `sku.id` ASC `FOR UPDATE` 는 **제거하지 않는다.** 다만 역할을 재정의한다.

> **SKU row lock 은 cycle serializability 의 primary guarantee 가 아니다.**
> cycle correctness 의 primary guarantee 는 **`BOM_CYCLE_GRAPH` transaction
> advisory lock** 이다.

row lock 이 계속 담당하는 것:

- candidate 의 parent/component **행 존재성 안정화**(검사 도중 SKU 가 archive 되는 것 방지)
- **activate 의 predecessor/successor chain mutation** 직렬화 (D-7)
- deterministic row mutation · 일반 write 경합

#### advisory lock 대상 operation

| endpoint | graph lock | 비고 |
|---|:-:|---|
| `POST /api/boms/{id}/lines` | ✅ | edge 추가 |
| `PATCH /api/boms/{id}/lines/{lid}` | ✅ | `componentSkuId` 변경 시 **old·new 두 SKU 모두** row lock |
| `DELETE /api/boms/{id}/lines/{lid}` | ✅ | edge 제거도 포함 — 동시 graph snapshot 일관성을 위해 |
| `PATCH /api/boms/{id}` | ✅ | `effectiveFrom` 등 **graph semantics 에 영향을 주는 header 변경** |
| `POST /api/boms/{id}/submit` | ✅ | 재검사 |
| `POST /api/boms/{id}/activate` | ✅ | 최종 `T` 기준 재검사 |
| `POST /api/boms/{id}/clone` | ✅ | 복제 결과 검사 |
| `POST /api/boms/import` | ✅ | 배치 전체에 **1회** |
| `POST …/approve` · `…/reject` | ⛔ | 아래 |
| `POST …/deactivate` · `…/archive` | ⛔ | edge 를 **제거**할 뿐이라 순환을 만들 수 없다 |
| `POST …/lines/bulk-confirm-qty` | ⛔ | `quantityPer` 만 바꾼다 — edge 불변 |
| 모든 `GET` | ⛔ | read-only |

**`approve`/`reject` 가 graph lock 대상이 아닌 이유** — D-13 이 확정한 graph
construction 은 sibling parent 를 **`resolveEffectiveBom`(= `status='ACTIVE'`
predicate)** 으로만 고른다. `PENDING_APPROVAL → APPROVED` 전이는 어느 버전도
`ACTIVE` 로 만들지 않으므로 **graph membership 을 바꾸지 않는다.** 그래프를
바꾸는 것은 `activate` 뿐이며 그쪽이 lock 대상이다. (candidate 자신은 D-13 이
status 와 무관하게 강제 투입하므로 approve 여부가 영향을 주지 않는다.)
★ 만약 후속 Recovery 가 D-13 의 sibling predicate 를 `ACTIVE` 외로 넓힌다면
**이 판정을 반드시 재검토**한다.

#### activate lock sequence

```
1. transaction 시작
2. pg_advisory_xact_lock(BOM_CYCLE_GRAPH_LOCK_KEY)
3. sku(parentSkuId) FOR UPDATE  → 필요한 bom_header 행 FOR UPDATE (id ASC)
4. 최종 T 결정 (body.effectiveFrom ?? target.effectiveFrom)
5. T 기준 cycle validation (D-13)
6. predecessor / successor temporal mutation (D-7 chain)
7. target activation (status=ACTIVE, activatedAt)
8. audit (ACTIVATE + predecessor UPDATE)
9. commit
```

EXCLUDE(`23P01`)는 여전히 최종 backstop 이다.

#### clone lock sequence

```
1. transaction 시작
2. pg_advisory_xact_lock(BOM_CYCLE_GRAPH_LOCK_KEY)
3. 새 header + lines 복제
4. 새 effectiveFrom 기준 candidate graph 검사 (D-13)
5. cycle 이면 **transaction 전체 rollback**
6. audit (CREATE) → commit
```

#### import lock sequence

`import` 는 `PENDING #7` 확정 전까지 T07-8 범위에서 유예하지만(D-1) 계약은
지금 고정한다.

```
1. transaction 시작 (동기·atomic — 부분 성공 금지, PENDING #7 조건 ③)
2. pg_advisory_xact_lock(BOM_CYCLE_GRAPH_LOCK_KEY)   ← 배치 전체에 1회
3. 전체 header/line 저장
4. imported header 마다 개별 candidate graph 검사 (D-13 — union 금지)
5. 하나라도 실패하면 배치 전체 rollback
6. commit
```

⛔ header 마다 advisory lock 을 acquire/release 반복하지 않는다.

#### 그 밖의 lock

| 시나리오 | 전략 |
|---|---|
| `bulk-confirm-qty` | `bom_header` 행 `FOR UPDATE` (graph lock 불필요) |
| version 중복 | lock 불필요 — `UNIQUE(parentSkuId, version)`(P2002 → 409) |
| 라인 중복 | lock 불필요 — D-3 의 표현식 UNIQUE(→ 409) |
| 기간 중첩 | lock 불필요 — EXCLUDE(`23P01` → 409) |

#### concurrency acceptance criteria (T07-2 DB integration)

아래 3종은 **실제 동시 트랜잭션**으로 실행한다. 순차 호출로 흉내 내면 계약을
검증하지 못한다.

**① 공유 노드 2-edge 직접 순환** (기존)

```
기존: A → B
TX1:  B → A 추가
```
기대 — 하나가 통과하고 다른 하나는 `BOM_CYCLE_DETECTED`. 최종 그래프에 순환 0.

**② ★ disjoint-lock 장주기 순환 — 필수 신규**

```
기존: A → B
      C → D
TX1:  B → C 추가      (구 계약의 lock set {B,C})
TX2:  D → A 추가      (구 계약의 lock set {D,A})
```

두 트랜잭션을 **실제 동시 실행**한다. 기대:

1. 둘 중 하나가 `pg_advisory_xact_lock` 에서 **대기**한다
2. 선행 트랜잭션 커밋 후, 후행 트랜잭션이 **새 그래프를 다시 읽어**
   **`BOM_CYCLE_DETECTED`** 로 실패한다
3. 최종 DB 그래프에 순환 **0건**

⛔ **이 테스트가 없으면 concurrency contract acceptance 미충족**이다. 구
계약(endpoint row lock)에서는 두 lock set 이 disjoint 라 **둘 다 통과**하므로,
이 테스트는 회귀 방지선 역할을 한다.

**③ 다이아몬드 동시 mutation — false positive 금지**

```
기존: A → B, A → C
TX1:  B → D 추가
TX2:  C → D 추가
```
기대 — advisory lock 으로 직렬화되지만 **둘 다 최종 성공**한다. 정상 DAG
mutation 이 직렬화 때문에 실패하거나 순환으로 오판되면 안 된다.

#### T06-3 price chain lock 과의 관계

T06-3 은 `supplier_sku` **행**을 잠그고, BOM 은 `BOM_CYCLE_GRAPH` advisory
lock → `sku` 행 순으로 잠근다. **자원 집합이 겹치지 않으므로 상호 deadlock 이
성립하지 않는다.** 향후 BOM 트랜잭션이 `supplier_sku` 를 잠글 일이 생기면
(예: 원가 산정을 write 경로에 넣는 경우) **advisory → sku → supplier_sku**
순서를 지킨다. 이 전역 lock order 를 `T07-2` 도메인 모듈 주석과 이 문서에
함께 남긴다.

### D-29 — error codes

기존 3종(문서 원문) + 신규 12종. 모두 `src/shared/errors/codes.ts` 의
**3개 map 전부**에 추가한다(기존 규약).

| code | HTTP | 발생 | 근거 |
|---|:-:|---|---|
| `BOM_ACTIVE_IMMUTABLE` | 422 | ACTIVE 수정 시도 | **원문** `05v2:352` |
| `BOM_CYCLE_DETECTED` | 422 | 순환 감지 | **원문** `05v2:353` |
| `BOM_QTY_UNCONFIRMED` | 422 | submit 시 미확정 라인 존재 | **원문** `05v2:354` |
| `BOM_NOT_FOUND` | 404 | id 없음 | 신규 |
| `BOM_VERSION_DUPLICATE` | 409 | `(parentSkuId, version)` 중복 (**P2002**) | 신규 |
| `BOM_PERIOD_OVERLAP` | 409 | ACTIVE 기간 중첩 (**23P01** EXCLUDE) | 신규 |
| `BOM_NOT_EDITABLE` | 422 | PENDING/APPROVED/INACTIVE/ARCHIVED 수정 | 신규 |
| `BOM_INVALID_TRANSITION` | 422 | D-6 표에 없는 전이 | 신규 |
| `BOM_SELF_COMPONENT` | 422 | parent == component | 신규 |
| `BOM_LINE_DUPLICATE` | 409 | D-3 위반 (표현식 UNIQUE) | 신규 |
| `BOM_QTY_INVALID` | 422 | `quantityPer <= 0` | 신규 |
| `BOM_QTY_STATUS_MISMATCH` | 422 | D-10 정합 위반 | 신규 |
| `BOM_UOM_MISMATCH` | 422 | D-11 위반 | 신규 |
| `BOM_MAX_LEVEL_EXCEEDED` | 422 | 전개 깊이 초과 | 신규 |
| `BOM_EFFECTIVE_CONFLICT` | 409 | asOf 유효 ACTIVE BOM 2건 이상 (D-22) | 신규 |
| `BOM_SUPPLIER_SELECTION_CONFLICT` | 409 | 대표 SupplierSku 2건 이상 (D-23) | 신규 |
| `BOM_PARENT_NOT_ELIGIBLE` / `BOM_COMPONENT_NOT_ELIGIBLE` | 422 | D-12 위반 | 신규 |

**Prisma / PostgreSQL 매핑** (T06-1·T06-2 선례 그대로):

| 원인 | Prisma | SQLSTATE | 번역 |
|---|---|---|---|
| EXCLUDE 위반 | `P2039` | **`23P01`** | `BOM_PERIOD_OVERLAP` (409) |
| CHECK 위반 | `P2039` | **`23514`** | 계약 버그 — 500 (DTO 가 먼저 막아야 함) |
| UNIQUE 위반 | `P2002` | `23505` | `meta.driverAdapterError.cause.constraint.fields` 로 분기 → `BOM_VERSION_DUPLICATE` / `BOM_LINE_DUPLICATE` |

⛔ 문서에 없는 코드를 임의로 더 만들지 않는다. 위 15종이 T07 의 전량이다.

### D-30 — T1-6B5 boundary

| 항목 | 확정 |
|---|---|
| mutation owner | **`/master/boms` standalone 화면**이 유일한 owner |
| SKU 상세 ⑦ BOM 탭 | **read-only summary + navigation** |
| 근거 | `05v2:455` **"상위/구성품 BOM 링크"** — "링크" 가 navigation 을 뜻한다. T05-4A(외부매핑)·T06-4(공급조건)와 같은 원칙 |
| 구현 가능 시점 | **`T07-3` 완료 직후** |
| 필요 API | `GET /api/boms?parentSkuId=` + `GET /api/skus/{id}/where-used` — **둘 다 T07-3 범위** (방향은 아래 표 참조) |
| permission | `bom.read` — **EXECUTIVE 포함** (D-15). ⛔ ⑥ 탭과 달리 숨기지 않는다 |

**⑦ 탭이 보여줄 것 (최소)**

1. **이 SKU 가 상위(parent)인 BOM** — 버전 · 상태 · 적용기간 · 구성품 수 · 미확정 수
2. **이 SKU 가 구성품(component)으로 쓰인 BOM** — 상위 SKU · 버전 · 상태 · 소요량
3. 각 행에서 **`/master/boms/{id}` 로 이동**하는 링크

#### ★ 두 API 의 방향 — 정정 (T07-3)

> ⚠️ 이 문서의 이전 "필요 API" 행은 괄호를 **반대로** 적어
> (`where-used`=상위 / `?parentSkuId=`=구성품) 위 ⑦탭 항목 설명과 모순됐다.
> 아래가 확정된 방향이며 코드도 이대로다.

SKU `X` 를 기준으로:

| endpoint | 의미 | ⑦탭 항목 |
|---|---|---|
| `GET /api/boms?parentSkuId=X` | **`X` 를 상위(완성) SKU 로 갖는 BOM 버전 목록** — "이 SKU 의 BOM" | 1 |
| `GET /api/skus/X/where-used` | **`X` 가 `BomLine.componentSkuId` 로 사용된 BOM 목록** — "이 SKU 를 어디에서 쓰는가" | 2 |

즉 **`where-used` = 사용처(구성품으로 쓰인 곳)** 이며, 이는 자재소요 도메인의
보편적 의미와 같다. T1-6B5 도 이 의미를 사용한다.

★ `where-used` 는 **한 행이 한 `BomLine`** 이다 — 같은 BOM 에 대체그룹만 다른
라인으로 두 번 쓰이면 행이 2개다. `quantityPer` 이 라인 단위 사실이라 header 로
접으면 표현할 수 없기 때문이다. ⛔ dedup·"최신 1건" 선택을 하지 않는다.
⛔ status·적용기간으로 거르지 않는다.

⛔ **T07-6(전개)·T07-7(원가)을 SKU 탭에 중복 구현하지 않는다.**
⛔ mutation control 을 하나도 만들지 않는다.

**T1-6B5 완료 후 SKU 상세 최종 8탭**

| # | 탭 | Task |
|---|---|---|
| 1 | 기본정보 | T1-6A |
| 2 | 코드·분류 | T1-6A |
| 3 | 바코드 | T1-6B1 |
| 4 | 외부시스템 매핑 | T1-6B2 |
| 5 | 재고관리 설정 | T1-6A |
| 6 | 공급조건 | T1-6B4 |
| **7** | **BOM** | **T1-6B5** |
| 8 | 변경이력 | T1-6B3 |

⑦ 은 ⑥ 과 ⑧ **사이**에 들어간다(`05v2:445` 원문 순서). E2E 5곳의
`BOM 탭 toHaveCount(0)` 부재 단언과 unit 의 7탭 스냅샷은 **T1-6B5 가 8탭으로
갱신**한다 — 예상된 regression 이며 T1-6B4 가 ⑥ 탭에서 겪은 것과 같다.

#### ★ 항목 3 navigation 의 task-order dependency — deferred rendering (T1-6B5 확정)

> 위 "⑦ 탭이 보여줄 것 (최소)" **항목 3**(각 행에서 `/master/boms/{id}` 로
> 이동하는 링크)은 **삭제되지 않았다.** 아래는 그 항목을 *언제* 렌더하는지에
> 대한 확정이며, 기능 축소가 아니라 **task 순서 의존성에 따른 연기**다.

| 항목 | 확정 |
|---|---|
| 요구사항 | D-30 항목 3 — 행에서 `/master/boms/{id}` 로 이동 (유효) |
| route owner | **T07-8** (D-31). `/master/boms` · `/master/boms/{id}` 2개 |
| T1-6B5 시점 상태 | 두 route 모두 **미구현** — 접근하면 404 |
| T1-6B5 렌더 결정 | **활성 링크를 렌더하지 않는다** (열 자체를 만들지 않는다) |
| 근거 | 없는 화면으로 보내는 링크는 사용자에게 404 를 준다. ⛔ 404 링크를 만들지 않는다 |
| 활성화 시점 | **T07-8 이 `/master/boms/{id}` 를 착지시킬 때 함께 켠다** |
| 활성화 절차 | `bom-view.ts` 의 `BOM_TAB_MANAGE_LINK_ENABLED` 를 `true` 로 바꾼다 (한 줄) |
| 경로 계약 | `bomManageLinkPath(bomHeaderId)` → `/master/boms/{bomHeaderId}` — 이미 고정돼 있고 unit 테스트가 지킨다 |

⚠️ `BOM_TAB_MANAGE_LINK_ENABLED` 는 **dead marker 가 아니다.** `bom-tab.tsx` 의
두 표(`TableHead` 머리글 열 · `ManageLinkCell` 셀)가 실제로 이 값을 조건으로
렌더하므로, 토글을 켜면 두 섹션 모두에 링크 열이 즉시 나타난다.

⛔ T1-6B5 는 `/master/boms` 를 **구현하지 않는다** — D-31 의 owner 는 T07-8 이다.
⛔ 링크를 대신할 다른 화면(예: dialog·inline 상세)을 임의로 만들지 않는다.

#### ★ status 표시 계약 — `BomStatus` 7종 exact key (T1-6B5 확정)

⑦ 탭은 D-6 의 **7종 전부**를 각각 다른 라벨로 표시한다. ⛔ 축약·병합 금지.

| enum key (authoritative) | ⑦ 탭 라벨 |
|---|---|
| `DRAFT` | 작성중 |
| `PENDING_APPROVAL` | 승인대기 |
| `REJECTED` | 반려 |
| `APPROVED` | 승인됨 |
| `ACTIVE` | 활성 |
| `INACTIVE` | 사용종료 |
| `ARCHIVED` | 보관 |

⛔ `PENDING` 은 **key 가 아니다** — 실제 key 는 `PENDING_APPROVAL` 이다.
⛔ `APPROVED`(승인 완료·미발효)와 `ACTIVE`(발효 중)를 합치지 않는다.
⛔ `ACTIVE` 를 "현재 적용중"으로 번역하지 않는다 — status 와 적용기간은 다른 축이다.
★ `where-used` 는 status 필터가 **없으므로** `ARCHIVED`·`INACTIVE` header 가
실제로 ⑦ 탭에 도달한다. 숨기지 않는다.

#### ★ 표시 식별자 계약 — `bomCode` 는 존재하지 않는다 (T1-6B5 확정)

D-2 가 확정한 `BomHeader` scalar 19 개에 **BOM 코드 필드는 없다.** BOM 의
identity 는 `id`(uuid) 와 `(parentSkuId, version)` UNIQUE 다.

| 섹션 | 열 | 실제 field |
|---|---|---|
| A (이 SKU 의 BOM) | 버전 · 유형 · 상태 · 적용기간 · 구성품 수 · 소요량 확정 | `version` · `bomType` · `status` · `effectiveFrom`/`effectiveTo` · `lineCount` · `lineCount`−`unconfirmedCount` |
| B (사용처) | **상위 SKU** · 버전 · 상태 · 적용기간 · 순번 · 소요량 · 소요량 상태 · 구성품 유형 · 필수 · 대체그룹 | `parentSku.skuCode`/`skuName` · `version` · `status` · 기간 · `lineNo` · `quantityPer`+`uom` · `quantityStatus` · `componentRole` · `isRequired` · `alternateGroup` |

⛔ "BOM 코드" 열을 만들지 않는다 — 그런 필드가 없다.
⛔ `${skuCode}-${version}` 같은 **합성 식별자**를 만들지 않는다.
⛔ `BomHeader.id`(uuid)를 "코드"로 표시하지 않는다 — key·`data-` 속성·링크
경로에만 쓴다.
★ 섹션 A 는 이미 해당 SKU 의 상세 화면 안이므로 상위 SKU 를 반복하지 않고
`version` 으로 구분한다.

### D-31 — standalone UI (T07-8)

route 는 정확히 **2개**. ⛔ `/new` route 없음(생성은 dialog — T06-4 와 같은 원칙).

#### `/master/boms` 목록 (`05v2:476-482`)

| 항목 | 확정 |
|---|---|
| 검색·필터 | `q`(상위 SKU 코드/상품명) · `status` · `bomType` · `parentSkuId` · `effectiveOn` · **`hasUnknownQty`** · `page` |
| 목록 열 | 상태 / 상위 SKU / 상품명 / 유형 / 버전 / 적용 시작일 / 적용 종료일 / 구성품 수 / **기준원가** / **미확정 항목 수** / 승인자 / 수정일 |
| 기준원가 | KRW subtotal 만 표시, 다른 통화가 있으면 `+` 표식 (D-26). 미확정이면 `잠정` 배지 |
| 버튼 | **신규**(dialog) · 복사 · 승인 요청 · 활성화 · 사용종료 |
| 유예 | **엑셀 업로드**(PENDING #7) · **전개/원가**(목록에서는 제외 — 상세 탭에서 한다) |
| 페이지 크기 | 서버 고정 **50** |
| 권한 | 조회 `bom.read` / 작성 `bom.create`·`bom.update` / 승인·활성화 `bom.approve` |

#### `/master/boms/[id]` 상세 (`05v2:485-494`)

**탭 4개** — 구성품 / 전개 / 원가 / 변경이력.

| 구분 | 확정 |
|---|---|
| 헤더 | 상위 SKU · 유형 · 버전 · 상태 · 기준수량·단위 · 적용기간 · 조립처 · 입고처 · 전체 로스율 · 변경사유 |
| 입고처·투입창고 | **UUID 를 그대로 표시**하거나 미표시. ⛔ 창고 이름 lookup 없음 (T08 미착수, D-32) |
| 라인 그리드 | 순번 / 구성품 SKU / 상품명 / 소요량 / 소요량 상태 / 단위 / 로스율 / **실제 필요량** / 구성품 유형 / 공급유형 / 대체그룹 / 필수 / 투입창고 / 입수량 / 상세사양 |
| **소요량 확정 UX** | ① `UNKNOWN` 행 빨간 배경 ② `packQuantity` 있으면 `1/입수량` **추천값(회색)** ③ 추천값 수락 버튼 ④ 일괄 확정 모드 ⑤ 진행률 바 `확정 N / 전체 M` |
| **활성 BOM** | 전체 읽기전용 + 배너 *"활성 BOM은 수정할 수 없습니다. 새 버전을 생성하세요."* + `버전 생성` 버튼 |
| 전개 탭 | `GET …/explode` 트리. `maxLevel` 선택. 순환 시 ErrorBanner |
| 원가 탭 | **기준일 선택**(기본 오늘) → 구성품별 단가·소요량·라인원가·비중·미확정. **통화·VAT 별 subtotal**. 미확정 시 `잠정` 배지 |
| 변경이력 탭 | `BomHeader`·`BomLine` audit 타임라인 |
| 상태 표시 | D-7 에 따라 **status 와 적용기간을 분리 표시**한다. `ACTIVE` 이면서 기간이 종료된 버전은 **"적용기간 종료"** 로 보여 현행 버전과 구분한다 |
| 권한별 노출 | mutation 버튼은 permission 없으면 **렌더하지 않는다**(disabled 아님) |
| loading / empty / error | 기존 `ErrorBanner`·`readApiError` 재사용. 403 은 빈 목록으로 위장하지 않는다 |

⛔ **새 UI component library 를 도입하지 않는다.** 기존 `components/ui` +
T06-4 의 `Dialog`/`DialogActions`/`TextInput` 패턴을 재사용한다.

★ **`잠정` 배지와 기준원가 열은 `T07-7A` 이후에야 값이 있다.** T07-8 이 T07-7
보다 뒤에 오도록 순서를 잡은 이유다(D-38).

### D-32 — boundaries / tests

| 경계 | 확정 |
|---|---|
| **T08 Warehouse** | `destinationWarehouseId`·`issueWarehouseId` 는 **FK 없는 UUID staged scalar**. ⛔ FK · relation · 이름 lookup · 선택 UI 없음. T08-1 구현 시 연결 (docs/17 §14 선례) |
| **Attachment** | BOM scope **0**. 필드·staged scalar 조차 만들지 않는다 |
| **legacy migration** | T07 구현과 **분리**. R1a-4 `T4-19` / Phase 8. 전량 `DRAFT`, 활성 0건, `version='1.0'`, `effectiveFrom=cutover_date` |
| **Posting / WO** | 미구현. D-19 의 수량·UOM 공식만 미래 dependency 로 고정 (`PENDING #5`) |
| **T1-4B** | 구현하지 않는다. T07-3 에서 **`hasBomUsage` provider** 만 노출해 나중에 쓸 수 있게 한다 (아래) |
| **`max-assembly-qty`** | R1a-2(재고 코어) 이후 별도 Task (D-1) |
| **BOM import** | PENDING #7 확정 후 (D-1) |
| **test framework** | Vitest · DB integration(Testcontainers/외부 PG) · Playwright. ⛔ **새 framework 도입 금지** |

#### `hasBomUsage` provider

`canArchiveSku({hasTransaction, hasBomUsage})` 와 `SkuArchiveBlocker='BOM_USAGE'`
는 **이미 순수 함수로 완성**돼 있다(`src/modules/sku/domain/archive-eligibility.ts`).
T07-3 은 아래 read service 만 제공하면 된다.

```
hasBomUsage(skuId) =
     EXISTS (SELECT 1 FROM bom_header WHERE parent_sku_id    = :skuId)
  OR EXISTS (SELECT 1 FROM bom_line   WHERE component_sku_id = :skuId)
```

`archive-eligibility.ts:26` 이 **"상위 SKU(parent)든 구성품(component)이든"** 으로
범위를 이미 확정했다. `@@index([componentSkuId])` 가 역전개용으로 설계돼 있어
두 번째 조건도 인덱스를 탄다. ⛔ T07 에서 `sku.archive` API 를 만들지 않는다.

#### test matrix

| Task | unit | DB integration | E2E |
|---|---|---|---|
| T07-1 | — | EXCLUDE 중첩 차단(**TC-BOM-004**) · 표현식 UNIQUE(D-3) · `(parentSkuId,version)` UNIQUE · CHECK · FK Restrict | — |
| T07-2 | cycle 5종(`A→A` / `A→B→A` / `A→B→C→A` / **다이아몬드=정상** / maxLevel) — **TC-BOM-001·007** · 검증규칙 14종 | ★ **evaluation-date graph**: 동일 parent 두 버전 동시 투입 없음 · historical/future ACTIVE 미혼입 · **union 이면 걸릴 false positive 가 통과** · candidate 자기 자신 강제 포함 · 다른 SKU 의 DRAFT 미포함 · `resolveEffectiveBom` 2건 → 409 · ★★ **동시성 3종**(§D-28 acceptance) | — |
| T07-3 | DTO strict · 편집 가능 상태 · route-policy first-match · **`alternateGroup` trim→blank→null 정규화** | CRUD · `BOM_ACTIVE_IMMUTABLE`(**TC-BOM-005**) · 권한 5역할 · 멱등 scope · audit 건수 · **header PATCH 로 `effectiveFrom` 변경 시 cycle 재검사** · **`alternate_group=''` 행이 생기지 않음** | — |
| T1-6B5 | 탭 노출·fallback · 표시 헬퍼 | where-used 응답 | 8탭 · 상위/구성품 · 링크 이동 · EXECUTIVE 노출 |
| T07-4 | 정합 3종 · 자동 1 금지(**TC-BOM-010**) · 0/음수(**TC-BOM-002**) | `pack=30`/`qty=1/30` 별도 저장(**TC-BOM-003**) · bulk 트랜잭션 | — |
| T07-5 | 전이 표 전량 · 자가승인 | **D-7 chain 전량**(미래/과거/gap/동일일/반복) · 동시 activate 수렴 · **TC-BOM-006** · ★ **activate `T` override 시 `T` 기준 cycle 재검사**(approve 통과 재사용 금지) · **clone 후 cycle 검사 + 실패 시 전체 rollback** | **E2E-05**(생성→일괄확정→승인→활성화) · **E2E-06**(활성 수정 차단→버전 생성→활성화) |
| T07-6 | 공식(D-19) · aggregation · ordering | 3단계 전개 정확(**TC-BOM-008**) · maxLevel · 순환 422 | — |
| T07-7A | provisional 조합 · subtotal grouping | SupplierSku 선택 0/1/2건 · price 0/1/2건 · **0원 ≠ 가격없음** · 통화 혼재(**TC-BOM-009**) | — |
| T07-7B | roll-up | 다단계 원가 | — |
| T07-8 | 목록 파라미터 · 폼 payload | — | 목록·상세·일괄확정·활성 배너·권한별 노출 |

**DB 테스트 skipped 0** 은 전 Task 공통 게이트다.

---

## 4. superseded clauses

| 원문 | 내용 | 대체 |
|---|---|---|
| `05:129` · `05v2:158` | activate 시 **기존 ACTIVE 자동 INACTIVE** | **§D-7** — status 를 바꾸지 않고 predecessor 의 `effectiveTo` 를 마감한다 |
| `07:*` E2E-06 | 구 버전 **자동 INACTIVE** | **§D-7** — 구 버전 **적용기간 자동 마감** |
| `03v2:276` | `UNIQUE(bom_header_id, component_sku_id, alternate_group)` | **§D-3** — `COALESCE(alternate_group,'')` 표현식 UNIQUE |
| `07:118` | 박스 단가 = 가격 ÷ 입수량 | **§D-19** — `quantityPer` 에 이미 반영. 원가에서 `packQuantity` 로 다시 나누지 않는다 |
| `05:133` | `cost` 의 `asOf` **required** | **§D-21** — optional, 기본 = 서버 업무일자 |
| `05:133` · `CostResult` | 단일 총액 암시 | **§D-26·D-27** — `(currency, vatIncluded)` 별 `subtotals[]`. 단일 `totalCost` 없음 |
| `05:133` | `cost` 권한 `전체+F` | **§D-15** — `bom.read` (F·E 포함). `bom.cost` 를 만들지 않는다 |
| `05v2:163` | `max-assembly-qty` 를 T3-10 에 포함 | **§D-1** — 현재고 의존이므로 R1a-2 이후로 유예 |
| `05v2:165` | BOM 동기 업로드를 T3-12 에 포함 | **§D-1** — PENDING #7 확정 전까지 유예 |
| `05:135` | `POST /api/boms/import` → `202 {jobId}` (비동기) | v0.2 가 **동기**로 supersede. 본 문서는 시점만 유예 |
| `05v2:150` | 수정 차단을 `ACTIVE` 만 명시 | **§D-6** — `PENDING_APPROVAL`·`APPROVED` 도 차단(`BOM_NOT_EDITABLE`) |

⛔ 위 원문 행을 **삭제하지 않는다.** 각 문서에 `SUPERSEDED BY docs/18 §Dx`
참조만 덧붙인다.

---

## 5. final implementation order

```
T07-1  schema
  ↓
T07-2  domain (cycle · 14종 · resolveEffectiveBom)
  ↓
T07-3  CRUD API (+ where-used · hasBomUsage provider · route-policy · permission seed)
  ↓
T1-6B5 SKU 상세 ⑦ BOM 탭 (read-only)      ← 여기서 삽입
  ↓
T07-4  quantity 관리 (bulk-confirm-qty)
  ↓
T07-5  workflow (submit/approve/reject/activate/deactivate/archive/clone)
  ↓
T07-6  explode
  ↓
T07-7A cost — 단일 레벨 (SupplierSku 선택 · price · currency/VAT · provisional)
  ↓
T07-7B cost — multi-level roll-up
  ↓
T07-8  standalone UI (/master/boms · /master/boms/{id})
```

| task | prerequisite | exact scope | explicit non-scope |
|---|---|---|---|
| **T07-1** | `T03-1`(SKU 스키마, 완료) | `BomHeader`/`BomLine`/enum 4종 · `Sku` inverse 2개 · migration(UNIQUE·표현식 UNIQUE·CHECK·EXCLUDE·index) · DB 테스트 | 도메인 · API · permission · UI |
| **T07-2** | T07-1 | `resolveEffectiveBom(s)` **먼저** → cycle DFS(evaluation-date graph) · 14종 · lock order 문서화 | API · UI |
| **T07-3** | T07-2 | CRUD 8 endpoint + `where-used` · DTO · permission seed 5종 · route-policy · audit · 멱등 · `hasBomUsage` provider | workflow · explode · cost · UI |
| **T1-6B5** | T07-3 | SKU 상세 ⑦ 탭 read-only · 8탭 전환 | mutation · explode · cost |
| **T07-4** | T07-3 | `quantityStatus` 정합 · `bulk-confirm-qty` · 추천값 계약 | UI |
| **T07-5** | T07-3, `T01-4`(승인 워크플로, 완료) | 7 workflow endpoint · **D-7 chain** · 자가승인 · clone | explode · cost · UI |
| **T07-6** | T07-2, T07-5 | `explode` · D-19 공식 · aggregation | `max-assembly-qty` · cost |
| **T07-7A** | T07-6, `T06-3`(완료) | 단일 레벨 원가 · D-23·D-24·D-25·D-26·D-27 | roll-up · UI |
| **T07-7B** | T07-7A | multi-level roll-up | UI |
| **T07-8** | T07-4, T07-7B | `/master/boms` 2 route · 상세 4탭 · 일괄확정 UI | import(PENDING #7) |

각 Task 는 **독립 PR** 이며 ⛔ 한 PR 에 schema + workflow + cost + UI 를 넣지
않는다. 모든 Task 는 `verify`(typecheck·lint·format·unit·DB·build) + drift + E2E
+ CI green 을 게이트로 한다.

---

## 6. unresolved issues (T07 착수를 막지 않음)

아래는 **해당 Task 착수 전**까지 확정하면 되는 항목이며, T07-1~T07-3 을
막지 않는다.

| # | 항목 | 필요 시점 | 성격 |
|---|---|---|---|
| U-1 | **PENDING #7** — BOM 동기 업로드 6조건 충족 여부, 미충족 시 CLI 전환 | `T07-8` 착수 전 | 사용자 결정 |
| U-2 | `max-assembly-qty` 의 현재고 소스·응답 형태 | R1a-2 이후 | 재고 코어 의존 |
| U-3 | **PENDING #5** — `ASSEMBLY`/`DISASSEMBLY` conservation 검증에서 D-19 공식을 어떻게 쓰는지 | R1a-2 착수 전 | 이 문서가 공식을 고정했으므로 소비 방식만 남음 |
| U-4 | BOM 목록 `기준원가` 열의 성능 — 목록 50행마다 원가를 계산하면 무겁다. 캐시/지연 로딩 여부 | `T07-8` 착수 전 | 구현 판단 |
| U-5 | `legacyBomCode`/`legacyCommonBomCode` 를 API 응답에 노출할지 | `T07-3` 착수 전 | 사소 |

---

## 7. Final Verdict

# T07 DESIGN RECOVERY COMPLETE — T07-1 READY

D-1 ~ D-32 를 전부 확정했다. PRE-FLIGHT 가 BLOCKED 로 든 14개 blocker 는 다음과
같이 해소됐다.

| blocker | 해소 |
|---|---|
| active BOM replacement 문서 모순 | **D-7** — status/period 의미 분리 + T06-3 식 chain |
| `bom_line` duplicate NULL 결함 | **D-3** — `COALESCE(…,'')` 표현식 UNIQUE |
| workflow transition graph 불완전 | **D-6** — 8전이 확정 + `archive` endpoint 신설 |
| UOM contract 부재 | **D-11** — component `baseUom` 고정, 환산 없음 |
| cycle 알고리즘/시점/scope 부재 | **D-13** — path 기반 DFS · **evaluation-date 별 parent당 1버전 graph**(union 폐기) · 7시점 |
| explode quantity formula 부재 | **D-19** — 가산식 확정 + precision |
| aggregation semantics 부재 | **D-20** — explode=detail / cost=합산 |
| SupplierSku selection rule 부재 | **D-23** — asOf 유효 `isPrimary` 1건 |
| provisional semantics 부재 | **D-25** — 3사유 · partial subtotal · 손상은 409 |
| mixed currency 처리 부재 | **D-26** — `(currency, vatIncluded)` subtotal, 환산 금지 |
| VAT normalization 부재 | **D-27** — 저장값 그대로, grouping 으로 분리 |
| concurrency lock contract 부재 | **D-28** — `BOM_CYCLE_GRAPH` **transaction advisory lock**(graph read 이전 획득) + row lock 은 보조 · 전역 lock order |
| API DTO 6종 미정 | **D-14** — 7종 전량 확정 |
| permission / audit 미정 | **D-15 / D-16** — 5 key + EXECUTIVE read · `ACTIVATE` 신규 action |

구현자는 이 문서만으로 **`T07-1` 부터 `T07-8` 까지 추가 추론 없이** 진행할 수
있으며, 각 Task 는 서로 모순되지 않는 하나의 architecture 를 이룬다.
