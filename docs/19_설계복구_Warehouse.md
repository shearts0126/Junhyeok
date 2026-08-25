# 설계복구 — Warehouse / WarehouseLocation (T08)

> **상태**: T08 FINAL DESIGN RECOVERY · 확정
> **baseline**: `f1570285b71ca834affdc4eac69f8eec2ab7dbd2`
> **선행 근거**: `docs/00 §2.2 G-05`·`§15 D-02` · `docs/03 §6.2`·`§7` ·
> `docs/05 §10.9`·`§11.10`·`§11.22` · `docs/06 §12.8` · `docs/07 R1a-2`
>
> 이 문서는 T08 PRE-FLIGHT 가 발견한 **12개 blocker** 를 닫는다.
> 여기서 확정한 것이 정본이며, 초안 문서와 충돌하면 **이 문서가 우선**한다.
> ⛔ 원문을 삭제하지 않는다 — 초안에는 `SUPERSEDED`/`CLARIFIED` pointer 만 남긴다.

---

## W-D1. Task 번호와 authoritative scope

`docs/07` v0.1 과 v0.2 의 분해가 다르다. **v0.2 scope 를 정본**으로 쓰되,
프로젝트가 지금까지 써 온 legacy 번호의 연속성을 위해 alias 를 유지한다.

| legacy | v0.2 | 범위 |
|---|---|---|
| **T08-1** | `T2-1A` | `Warehouse`·`WarehouseLocation` schema + **warehouse relation landing** |
| **T08-2** | `T2-1B` | application/API + DEFAULT location transaction + **15종 seed** |
| ~~T08-3~~ | **`T2-20`** | ⛔ **SUPERSEDED / DEFERRED** — 창고 화면 |

`T08-1 + T08-2` 가 모두 끝나면 v0.2 `T2-1` 이 CLOSED 된다.

**⛔ legacy `T08-3`(창고 화면)은 지금 구현하지 않는다.** v0.2 가 화면을 `T2-20`
으로 옮긴 것은 "재고 존재 시 비활성 차단" 이 current-stock capability 를
요구하기 때문이다. 재고 모델이 없는 상태에서 이를 구현하면 `hasInventory=false`
같은 **가짜 구현**이 필요해지고, 그것은 안전장치를 무효화한다
(선례: `src/modules/sku/application/workflow.ts` 가 BOM usage provider 부재를
이유로 `archive` 를 T1-4B 로 연기하면서 **"상수 가정 금지·라우트 stub 금지"** 를
명시했다).

실행 순서: `T08-1` → `T08-2` → `T2-1` CLOSED → 이후 R1a-2 authoritative 순서.

---

## W-D2. WarehouseType — exact 6종

```
INTERNAL  THREE_PL  SUPPLIER_SITE  OVERSEAS  VIRTUAL  IN_TRANSIT
```

`docs/03` v0.1·v0.2 가 **완전히 동일**하다. ⛔ 그 외 값 0.

---

## W-D3. Warehouse — exact schema

| 필드 | 타입 | null | 제약·기본값 |
|---|---|:-:|---|
| `id` | UUID | N | PK, `default uuid()` |
| `warehouseCode` | VarChar(50) | N | **global UNIQUE** |
| `warehouseName` | VarChar(150) | N | |
| `warehouseType` | `WarehouseType` | N | |
| `externalSystemId` | UUID | Y | → `ExternalSystem.id` (W-D14) |
| `supplierId` | UUID | Y | → `Supplier.id` (W-D13) |
| `defaultLocationId` | UUID | **N** | **NOT NULL** (W-D5·W-D6) |
| `timezone` | VarChar(50) | N | default `'Asia/Seoul'` |
| `address` | Text | Y | |
| `active` | Boolean | N | default `true` |
| `createdAt` | Timestamptz | N | `default now()` |
| `updatedAt` | Timestamptz | N | `@updatedAt` |

⛔ `createdBy`·`updatedBy` 를 **추가하지 않는다** — Sku·Supplier 관례와 다르지만
`docs/03` 초안이 그렇게 정했고, 변경 근거가 없다.
⛔ `deletedAt` 을 추가하지 않는다.

---

## W-D4. WarehouseLocation — exact schema

| 필드 | 타입 | null | 제약·기본값 |
|---|---|:-:|---|
| `id` | UUID | N | PK, `default uuid()` |
| `warehouseId` | UUID | N | → `Warehouse.id` |
| `locationCode` | VarChar(50) | N | |
| `locationName` | VarChar(150) | **N** | |
| `locationType` | VarChar(30) | Y | |
| `active` | Boolean | N | default `true` |

- **UNIQUE `(warehouseId, locationCode)`** — 백로그의 `(warehouseId, code)` 는
  같은 것의 축약 표기다.
- **`@@unique([warehouseId, id])`** 를 추가한다 — W-D6 composite FK 의 target.
  `id` PK 와 논리적으로 중복이지만 **명시적 FK target key** 로서 필요하다.
- ⛔ `createdAt`·`updatedAt` 을 추가하지 않는다 (초안 그대로).

---

## W-D5. `defaultLocationId` 는 **NOT NULL** 이다

PRE-FLIGHT 의 권장안(`nullable 유지`)은 **채택하지 않는다.**

| 출처 | 내용 | 판정 |
|---|---|---|
| `docs/00 G-05` | `default_location_id` **NOT NULL** 강제 | ★ **정본** |
| `docs/03` 초안 | `defaultLocationId String? @db.Uuid` | ⛔ **SUPERSEDED** |
| `docs/07` T08-2 / T2-1 | 완료조건 "생성 직후 NOT NULL 보장" | 정본과 정합 |

**근거**: 재고 식별키에 `location_id` 가 포함되고(재고 PRD §5.1), 로케이션 미사용
창고는 `DEFAULT` 를 자동 적용한다(§3.6). DEFAULT 가 없는 창고가 한 순간이라도
존재하면 **Posting 이 FK 오류로 전면 실패**한다. G-05 가 굳이 DB 수준 NOT NULL
까지 요구한 이유가 이것이다.

⛔ `nullable 로 INSERT 했다가 UPDATE` 하지 않는다 (W-D7).

---

## W-D6. same-warehouse composite FK

단순 `defaultLocationId → WarehouseLocation.id` 만으로는 **다른 창고의
로케이션을 default 로 지정하는 것**을 막지 못한다.

```sql
ALTER TABLE warehouse
  ADD CONSTRAINT warehouse_default_location_fk
  FOREIGN KEY (id, default_location_id)
  REFERENCES warehouse_location (warehouse_id, id)
  DEFERRABLE INITIALLY DEFERRED;
```

- `(id, default_location_id)` → `(warehouse_id, id)` 이므로 **default 는 반드시
  자기 창고의 로케이션**이다.
- `DEFERRABLE INITIALLY DEFERRED` 는 **이 FK 하나에만** 적용한다. 순환 INSERT
  때문이며, commit 시점에 검증된다.
- ⛔ 다른 FK 를 deferrable 로 만들지 않는다.
- 이 constraint 는 Prisma 가 표현하지 못하므로 **migration raw SQL** 로 만든다
  (`bom_header_active_period_excl` 선례와 같은 방식).

---

## W-D7. 창고 생성 트랜잭션 — exact sequence

```
transaction 밖:
  warehouseId       = UUID 생성
  defaultLocationId = UUID 생성        ← 미리 만든다

BEGIN
  1. INSERT Warehouse
       id                = warehouseId
       defaultLocationId = defaultLocationId   ← null 로 넣지 않는다
       active            = true
  2. INSERT WarehouseLocation
       id           = defaultLocationId
       warehouseId  = warehouseId
       locationCode = 'DEFAULT'
       locationName = 'DEFAULT'
       locationType = null
       active       = true
  3. audit / idempotency 기록
COMMIT                                  ← deferred FK 가 여기서 검증된다
```

- 어느 단계든 실패하면 **warehouse·location 전부 rollback**.
- ⛔ 중간 warehouse row 잔존 금지.
- 동일 idempotency key 재요청은 **logical create 1회** — DEFAULT child 를 다시
  만들지 않는다.

---

## W-D8. G-05 CLARIFIED

`docs/00 G-05` 의 **"생성 후 즉시 UPDATE"** 는 구현 순서 서술이며 **CLARIFIED**
된다. 목적(**NOT NULL · 동일 트랜잭션 · DEFAULT 보장**)은 그대로다.

pre-generated UUID 방식은 후속 `UPDATE` 자체가 필요 없고, DB invariant 가 **더
강해진다** — warehouse row 가 존재하는 모든 시점에 `default_location_id` 가
채워져 있다.

---

## W-D9. `DEFAULT` 는 예약 코드다

`POST /api/warehouses/{id}/locations` 에서

```
trim(locationCode).toUpperCase() === 'DEFAULT'
```

이면 **400**. 자동 생성만이 DEFAULT 의 owner 다.

- 예약 판정만 **case-insensitive** 다.
- ⛔ 일반 location code 를 uppercase 로 강제 변환하지 않는다 — 저장·UNIQUE 는
  기존 case-sensitive 관례를 유지한다.

---

## W-D10. DEFAULT location 은 변경할 수 없다

현재 endpoint inventory 에 **location PATCH·DELETE 가 없다.** 따라서 `T2-1`
범위에서 DEFAULT 의 rename·deactivate·delete 는 **전부 0** 이다.

⛔ 새 endpoint 를 발명하지 않는다. 일반 location 도 현재 **create/read 만**
지원한다.

---

## W-D11. `IN_TRANSIT` — 시스템 예약 창고

seed 가 만드는 **정확히 1개**의 system-reserved warehouse.

| 필드 | 값 |
|---|---|
| `warehouseCode` | `IN_TRANSIT` |
| `warehouseName` | `이동중` |
| `warehouseType` | `IN_TRANSIT` |
| `active` | `true` |
| `supplierId` | `null` |
| `externalSystemId` | `null` |
| `timezone` | `Asia/Seoul` |

DB 에서 최대 1행임을 **partial UNIQUE** 로 강제한다.

```sql
CREATE UNIQUE INDEX warehouse_in_transit_singleton
  ON warehouse ((warehouse_type)) WHERE warehouse_type = 'IN_TRANSIT';
```

이 창고는 향후 창고이동의 **system transit bucket** owner 다.

---

## W-D12. `IN_TRANSIT` public mutation 금지

- `POST /api/warehouses` 에서 `warehouseType = IN_TRANSIT` → **400**
- `warehouseCode = IN_TRANSIT` → **400**
- `IN_TRANSIT` row 의 일반 `PATCH` → **금지**
- `active = false` → **금지**
- 삭제 endpoint → **없음**
- ⛔ `IN_TRANSIT` 창고에 추가 location 을 만들지 않는다 — DEFAULT 만 쓴다.

owner 는 seed/system setup 뿐이다.

---

## W-D13. ★ Warehouse ↔ Supplier **staged-link lifecycle**

T08 PRE-FLIGHT 가 `SUPPLIER_SITE ⇔ supplierId NOT NULL` 을 T08 시점 DB CHECK 로
강제하면 **authoritative migration 순서가 실행 불가능**해짐을 실측으로 확인했다.

```
docs/06 Phase 3 — 창고·로케이션 (3PL 3 + SUPPLIER_SITE 11 + IN_TRANSIT 1 = 15)
        ↓
docs/06 Phase 7 — 거래처 (40) + 공급조건 + 가격이력
```

`docs/06 §12.8` 원문: *"`SUPPLIER_SITE` 는 `supplier_id` FK 연결
(**Phase 7 거래처 이관 후 연결**, 또는 Phase 3에서 거래처 선등록)"*

즉 정본 자체가 **창고 시드 시점에 거래처가 없음**을 전제한다.

### 결론 — warehouse 존재와 supplier link 완성의 milestone 을 분리한다

| 단계 | `supplierId` | DB 강제 |
|---|---|---|
| **T08 (T2-1)** | seed 11건은 `null` — **legacy/bootstrap transitional state** | **one-way CHECK 만** |
| **Supplier migration 후** | 실제 Supplier 로 backfill | **two-way IFF CHECK 추가** |

### T08 단계의 DB CHECK — one-way

```sql
CHECK (supplier_id IS NULL OR warehouse_type = 'SUPPLIER_SITE')
```

- 금지: `INTERNAL`·`THREE_PL`·`OVERSEAS`·`VIRTUAL`·`IN_TRANSIT` + `supplierId`
- 허용: `SUPPLIER_SITE` + `supplierId = null` ← **transitional state**

⛔ **T08-1/T08-2 에서 아래를 추가하지 않는다.** 추가하면 seed 11건이 실패한다.

```sql
-- ⛔ T08 에서 금지 — Supplier migration 이후에만 추가
CHECK (warehouse_type <> 'SUPPLIER_SITE' OR supplier_id IS NOT NULL)
```

### runtime 규칙은 여전히 strict 하다

DB 가 transitional state 를 표현할 수 있다는 것이 **사용자가 unlinked
`SUPPLIER_SITE` 를 새로 만들어도 된다는 뜻이 아니다.**

- `POST` — `warehouseType = SUPPLIER_SITE` 인데 `supplierId` 없음 → **400**
- `POST`/`PATCH` — non-`SUPPLIER_SITE` + `supplierId` non-null → **400**
- `PATCH` — `SUPPLIER_SITE` 의 `supplierId` 를 명시적 `null` 로 만들기 → **금지**
- seeded row 의 `supplierId = null` 은 **정상 상태**다 — `GET`/list 가 실패하거나
  DB corruption 으로 취급하지 않는다.
- Supplier 가 생긴 뒤 `supplierId` non-null `PATCH` 로 연결 가능. 단 legacy 대량
  연결의 owner 는 UI 수작업이 아니라 **migration backfill** 이다.

### 최종 운영 불변식 (복구 시점)

```
warehouseType == SUPPLIER_SITE  IFF  supplierId IS NOT NULL
```

순서: ① Supplier migration 완료 → ② 11개 backfill → ③ unlinked
`SUPPLIER_SITE` count **0** 검증 → ④ wrong-type `supplierId` count **0** 검증
→ ⑤ two-way CHECK 추가 → ⑥ migration completion.

**owner**: `docs/07` v0.2 **`T4-19` 마이그레이션 Phase 1~8** 의 **Phase 7**
(거래처 이관 + warehouse supplier-link closure). ⛔ 새 task ID 를 발명하지 않는다.

---

## W-D14. `externalSystemId`

- `Warehouse.externalSystemId` → `ExternalSystem.id` **optional real FK** 로 landing.
- Prisma 가 요구하므로 `ExternalSystem` 쪽 inverse 도 추가.
- ⛔ `THREE_PL`·`OVERSEAS` 등 특정 타입에서 **required 로 만들지 않는다** —
  현재 문서 근거가 없다. **all types optional.**
- public API 에서 optional nullable field.

**seed 값**: 현재 `ExternalSystem` 은 **seed 가 존재하지 않으며**, 실 DB 의 2건
(`ZZX-ERP`·`ZZX-OFF`)은 전부 E2E 픽스처다. `docs/03 §6.2` 가 `OLPUN` 을
"이벗매니저 연동" 이라 서술하지만 **`Warehouse.externalSystemId` 매핑을 지정한
근거는 아니다.** 따라서 **15건 전부 `externalSystemId = null` 로 seed** 한다.
⛔ 이름이 같다는 이유만으로 자동 relation 금지.

---

## W-D15. staged warehouse 참조 — exact 5종 landing

T08-1 에서 UUID scalar-only staged state → **real FK/relation** 으로 승격한다.

| # | 모델 | 컬럼 | defer 근거 |
|---|---|---|---|
| 1 | `SkuExternalMapping` | `warehouseId` | `docs/12` |
| 2 | `Supplier` | `defaultWarehouseId` | `docs/17` |
| 3 | `SupplierSku` | `destinationWarehouseId` | `docs/17` |
| 4 | `BomHeader` | `destinationWarehouseId` | `docs/18 §D-32` |
| 5 | `BomLine` | `issueWarehouseId` | `docs/18 §D-32` |

전부 `Warehouse.id` FK. 여기에 더해 `Warehouse.supplierId → Supplier.id`,
`Warehouse.externalSystemId → ExternalSystem.id`, W-D6 composite relation 까지
같이 landing 한다.

---

## W-D16. Prisma inverse relation

**"API inverse 노출"과 "Prisma inverse relation"은 다른 것이다.** Prisma 가
relation 완성을 위해 요구하는 inverse field 는 추가한다.

- `Warehouse` ↔ `WarehouseLocation`
- `Warehouse` ↔ `Supplier.defaultWarehouse`
- `Warehouse` ↔ `SupplierSku.destinationWarehouse`
- `Warehouse` ↔ `BomHeader.destinationWarehouse`
- `Warehouse` ↔ `BomLine.issueWarehouse`
- `Warehouse` ↔ `SkuExternalMapping.warehouse`
- `Warehouse` ↔ `ExternalSystem`

★ **Supplier ↔ Warehouse 는 두 개의 별도 relation** 이다.

| 방향 | 의미 |
|---|---|
| `Warehouse.supplierId → Supplier` | 이 창고가 **어느 제조사의 보관처**인가 |
| `Supplier.defaultWarehouseId → Warehouse` | 이 거래처의 **기본 입고 창고**는 어디인가 |

⇒ **named relation 으로 반드시 분리**한다. 이름을 생략하면 Prisma 가 두 관계를
구분하지 못한다.

---

## W-D17. public API projection 경계

relation landing 때문에 **기존 API 응답을 조용히 바꾸지 않는다.**

| 모듈 | 규칙 |
|---|---|
| Supplier | `defaultWarehouseId`·`destinationWarehouseId` — 기존 final contract 대로 **입출력 제외 유지** |
| BOM | T07 final contract 유지. ⛔ warehouse name join 을 자동 추가하지 않는다 |
| ExternalMapping | `warehouseId` 는 현재 **입력 400 · 저장 null** 계약을 T08-1 때문에 바꾸지 않는다 |

**schema relation landing ≠ existing module API expansion.**

---

## W-D18. 미래 재고 relation — 생성 금지

⛔ `Warehouse.ledgerEntries` · `Warehouse.balances` · `Sku.ledgerEntries` ·
`Sku.balances` 등 **T09 소유 relation 을 T08 에서 만들지 않는다.**
⛔ `InventoryLedgerEntry`·`InventoryBalance` **stub 0**.

`docs/03` 초안의 두 inverse 는 T09 authoritative schema landing 시 추가한다.

---

## W-D19. FK delete/update matrix

T08 에서 landing 하는 warehouse 관계는 전부:

```
ON UPDATE CASCADE   ON DELETE RESTRICT
```

대상: `WarehouseLocation.warehouseId` · W-D6 composite FK ·
`Warehouse.supplierId` · `Warehouse.externalSystemId` ·
`Supplier.defaultWarehouseId` · `SupplierSku.destinationWarehouseId` ·
`BomHeader.destinationWarehouseId` · `BomLine.issueWarehouseId` ·
`SkuExternalMapping.warehouseId`.

⛔ CASCADE delete **0** · ⛔ SET NULL **0**.
Warehouse/location 물리 삭제 API 자체가 이번 scope 에 없다.

---

## W-D20. 기존 staged 데이터 호환성 — 문제 없음

PRE-FLIGHT 실측:

| 대상 | non-null 건수 |
|---|---|
| 5개 staged warehouse UUID 컬럼 (현재 DB) | **0** |
| seed | **0** |
| E2E fixture | **0** |

⇒ FK landing 을 위한 data rewrite · placeholder Warehouse · NULL overwrite ·
record deletion 이 **전부 불필요**하다. 다만 각 FK 가 실제로 invalid UUID 를
차단하는지는 T08-1 DB 테스트로 검증한다.

---

## W-D21. 기존 staged-state 테스트의 supersession

PRE-FLIGHT 가 확인한 **6파일 9지점**은 T08-1 에서 의도적으로 supersede 된다.

| 파일 | 지점 |
|---|---|
| `src/modules/external-mapping/external-mapping-crud.test.ts` | 204 · 538 |
| `tests/db/external-mapping-crud.test.ts` | 485 |
| `tests/db/sku-external-mapping-schema.test.ts` | 348 · 716 |
| `tests/db/supplier-schema.test.ts` | 219 · 379 |
| `tests/db/bom-schema.test.ts` | 515 · 528 |
| `tests/db/bom-crud-api.test.ts` | 315 |

⛔ **그냥 삭제하지 않는다.** 각 테스트의 계약을
*"Warehouse 미구현이라 arbitrary UUID 가능"* → *"Warehouse landing 후 FK
enforced"* 로 **명시적으로 전환**하고, 이 문서를 pointer 로 남긴다.
(`bom-schema.test.ts:528`·`sku-external-mapping-schema.test.ts:354` 는 이미
"T08-1 에서 반대 방향으로 바뀌어야 한다"고 예고해 두었다.)

---

## W-D22. Permission — exact 3종

```
warehouse.read   warehouse.create   warehouse.update
```

⛔ 4번째 key **없음**.

| permission | ADMIN | SCM_LEADER | SCM_STAFF | FINANCE | EXECUTIVE |
|---|:-:|:-:|:-:|:-:|:-:|
| `warehouse.read` | ✅ | ✅ | ✅ | — | — |
| `warehouse.create` | ✅ | — | — | — | — |
| `warehouse.update` | ✅ | — | — | — | — |

**충돌 해소**: `docs/05` v0.1 API 표의 GET `"전체"` 와 `§11.10` 의 "조회 전체" 는
**v0.2 `§11.22` 화면 권한 matrix(`S=R L=R A=RW F=— E=—`)가 SUPERSEDE** 한다.
FINANCE·EXECUTIVE 는 창고 조회 권한이 없다.

⛔ role 문자열(`ADMIN`)을 application 에서 직접 검사하지 않는다.
**RolePermission 데이터로만** 판정하며 **ADMIN bypass 0**.

---

## W-D23. Route ↔ permission ownership

| method · route | permission |
|---|---|
| `GET /api/warehouses` | `warehouse.read` |
| `GET /api/warehouses/{id}/locations` | `warehouse.read` |
| `POST /api/warehouses` | `warehouse.create` |
| `PATCH /api/warehouses/{id}` | `warehouse.update` |
| `POST /api/warehouses/{id}/locations` | **`warehouse.update`** |

route-policy(proxy) 1차 가드 + application service 2차 가드.
UI 는 `T2-20` 이므로 **이번 단계 UI permission rendering 0**.

---

## W-D24. `CreateWarehouseDto`

| 필드 | 필수 | 규칙 |
|---|:-:|---|
| `warehouseCode` | ✅ | trim · nonblank · max 50 |
| `warehouseName` | ✅ | trim · nonblank · max 150 |
| `warehouseType` | ✅ | exact enum 6종 |
| `externalSystemId` | — | UUID · nullable |
| `supplierId` | — | UUID · nullable · **W-D13 runtime 규칙 적용** |
| `timezone` | — | 생략 시 `Asia/Seoul`. ⛔ explicit `null` 금지. trim · nonblank · max 50 |
| `address` | — | nullable free text |

⛔ 입력 금지: `id` · `defaultLocationId` · `active` · `createdAt` · `updatedAt`.

---

## W-D25. create-only immutable

`warehouseCode` 와 `warehouseType` 은 **create-only immutable** 이다.
PATCH 에서 입력하면 **400**.

**근거**: 향후 거래·외부연동·system warehouse semantics 의 identity field 이며,
W-D11·W-D12 의 `IN_TRANSIT` 예약도 이 불변식에 의존한다.

---

## W-D26. `UpdateWarehouseDto` (T2-1 단계)

편집 가능: `warehouseName` · `externalSystemId` · `supplierId` · `timezone` ·
`address`.

- `warehouseType` 이 immutable 이므로 `supplierId` 를 non-null 로 바꾸는 것은
  **`SUPPLIER_SITE` 창고에서만** 가능하다. non-`SUPPLIER_SITE` 는 계속 null.
- ⛔ 입력 금지: `active`(W-D27) · `warehouseCode` · `warehouseType` ·
  `defaultLocationId`.
- `{}` → **400**. `undefined` → unchanged. nullable field 의 explicit `null` →
  clear.
- **no-op**: `200` + 현재 view + **DB UPDATE 0 · Audit 0 · `updatedAt` 불변**.

---

## W-D27. `active` mutation 은 T2-20 으로 연기

`active` 컬럼은 T08-1 schema 에 **존재**하고 신규 창고는 항상 `true` 다.
그러나 `true→false`·`false→true` **mutation 은 T2-1 에서 제공하지 않는다.**
`PATCH active` → **400**.

이 lifecycle 은 `T2-20` 에서 current-stock provider 와 함께 landing 한다.
⛔ `hasInventory=false` 상수 가정 · dummy provider · empty stub **전부 금지**.

---

## W-D28. legacy T08-3 → `T2-20`

`T2-20` 이 함께 처리할 것: `/master/warehouses` UI · `재고 SKU 수` 열 ·
active/inactive lifecycle · **재고 존재 시 비활성 차단** · current-stock 연동.

따라서 이번 recovery 에서 창고 UI 상세 route 를 결정하지 않는다.
현재 authoritative route 는 사이트맵의 **`/master/warehouses`** 뿐이며
⛔ `/master/warehouses/{id}` 를 지금 발명하지 않는다.

---

## W-D29. `timezone` 의 의미

`Warehouse.timezone` 은 **display · 외부 연동 · 로컬 운영 metadata** 다.

⛔ **재고 `business_date` 의 기준이 아니다.** `docs/00 G-08` 이 확정한 대로
`business_date` 는 전사 **`Asia/Seoul` 고정**이다. warehouse timezone 이
`America/Los_Angeles` 여도 수불부·월마감·재고 business_date 를 그 timezone 으로
계산하지 않는다.

`T2-1` 에서 IANA timezone validation library 를 **새로 도입하지 않는다** —
trim · nonblank · max 50 · default `Asia/Seoul`.

---

## W-D30. `GET /api/warehouses` — list contract

| 항목 | 값 |
|---|---|
| query | `warehouseType?` · `active?` · `page?` — **그 외 400** |
| `q` | **없음** |
| `sort` | **없음** |
| `pageSize` | public query **없음** — 서버 고정 **50** |
| `page` | positive integer, default 1 |
| envelope | `{ items, page, pageSize, total, totalPages, requestId }` |
| 정렬 | `warehouseCode ASC` → `id ASC` |
| 기본 필터 | ⛔ `active=true` 자동 필터 **없음** — active·inactive 모두 포함 |

---

## W-D31. `WarehouseView`

```
id · warehouseCode · warehouseName · warehouseType · externalSystemId ·
supplierId · defaultLocationId · timezone · address · active ·
createdAt · updatedAt
```

⛔ 관계 객체 자동 include 금지 — `supplier` object 없음 · `externalSystem`
object 없음 · list 응답에 `locations` inline 없음.
DateTime 은 ISO-8601 문자열.

---

## W-D32. `GET /api/warehouses/{id}/locations`

- query **없음** (있으면 400).
- parent warehouse 없음 → **404**.
- 페이지네이션 **없음**.
- 정렬 `locationCode ASC` → `id ASC`.
- active·inactive 모두 포함, **DEFAULT 포함**.
- 응답은 프로젝트의 하위 리소스 관례대로 `{ ...result, requestId }` envelope 을
  따른다 (`GET /api/skus/{id}/supplier-skus` 선례).
- 정상 창고라면 W-D7 때문에 **locations 가 0건일 수 없다.**

---

## W-D33. `LocationView` · `CreateLocationDto`

**LocationView**: `id` · `warehouseId` · `locationCode` · `locationName` ·
`locationType` · `active`.

**CreateLocationDto**

| 필드 | 필수 | 규칙 |
|---|:-:|---|
| `locationCode` | ✅ | trim · nonblank · max 50 · **W-D9 예약 검사** |
| `locationName` | ✅ | trim · nonblank · max 150 |
| `locationType` | — | nullable. 값이면 trim · nonblank · max 30 |

⛔ 입력 금지: `id` · `warehouseId` · `active`.

---

## W-D34. `POST /api/warehouses/{id}/locations`

- warehouse 없음 → **404**.
- `IN_TRANSIT` 창고 → **금지** (W-D12).
- `(warehouseId, locationCode)` 중복 → **409**.
- ⛔ 새 error taxonomy 를 만들지 않는다 — 기존 duplicate/conflict 오류 관례를
  재사용한다. **새 generic error framework 금지.**

---

## W-D35. Audit

| 대상 | audit |
|---|---|
| Warehouse CREATE · UPDATE | ✅ |
| WarehouseLocation CREATE | ✅ |
| read (GET) | **0** |
| no-op update | **0** |
| **seed 로 만든 warehouse/location** | **0** |

seed 는 deployment/bootstrap 데이터이지 runtime actor mutation 이 아니다.
기존 `entityType` 문자열 관례(`'Sku'`·`'Supplier'`·`'BomHeader'` 등)를 그대로
따른다 — 새 Audit action enum 을 만들지 않는다.

---

## W-D36. Idempotency

| endpoint | scope | 최초 | replay | key 재사용 |
|---|---|:-:|:-:|---|
| `POST /api/warehouses` | `warehouse:create` | 201 | 200 | 409 `IDEMPOTENCY_KEY_REUSED` |
| `POST …/{id}/locations` | `warehouse:{warehouseId}:location:create` | 201 | 200 | 409 |
| `PATCH` | — | — | — | idempotency 미지원 |

canonical hash 는 **검증된 DTO** 기준이다.
★ replay 시 DEFAULT child 를 **다시 만들지 않는다**.

---

## W-D37. 창고 15종 seed (exact)

| # | `warehouseCode` | 명칭 | `warehouseType` | `supplierId` |
|---|---|---|---|---|
| 1 | `OLPUN` | 올펀 | `THREE_PL` | null |
| 2 | `PUMGO` | 품고 | `THREE_PL` | null |
| 3 | `RODIT` | 로딧 | `THREE_PL` | null |
| 4 | `SUP_BOC` | 본코스메틱 (BOC) | `SUPPLIER_SITE` | **null (transitional)** |
| 5 | `SUP_IJC` | 일진코스메틱 | `SUPPLIER_SITE` | **null (transitional)** |
| 6 | `SUP_CSM` | 코스메카코리아 | `SUPPLIER_SITE` | **null (transitional)** |
| 7 | `SUP_CLB` | 갈렙이앤씨 | `SUPPLIER_SITE` | **null (transitional)** |
| 8 | `SUP_MKM` | 마케모 | `SUPPLIER_SITE` | **null (transitional)** |
| 9 | `SUP_EZC` | 이지코어 | `SUPPLIER_SITE` | **null (transitional)** |
| 10 | `SUP_CTK` | 씨티케이 | `SUPPLIER_SITE` | **null (transitional)** |
| 11 | `SUP_RBM` | 리봄화장품 | `SUPPLIER_SITE` | **null (transitional)** |
| 12 | `SUP_JPS` | 제이피에스코스메틱 | `SUPPLIER_SITE` | **null (transitional)** |
| 13 | `SUP_NNN` | 뉴앤뉴 | `SUPPLIER_SITE` | **null (transitional)** |
| 14 | `SUP_BON` | 본코스메틱 (BON) | `SUPPLIER_SITE` | **null (transitional)** |
| 15 | `IN_TRANSIT` | 이동중 | `IN_TRANSIT` | null |

- 전 창고에 **`DEFAULT` 로케이션 정확히 1개** (총 15개).
- `timezone` 전부 `Asia/Seoul`, `externalSystemId` 전부 `null`(W-D14),
  `active` 전부 `true`.
- seed 는 **idempotent** 하다.
- ⛔ 임의 추가·삭제 금지 · ⛔ fake Supplier 생성 **0** · ⛔ `supplierCode` 추정 **0**.

---

## W-D38. Supplier link — DEFERRED BY DESIGN

11개 `SUPPLIER_SITE` 창고의 supplier 연결 상태:

| warehouseCode | 상태 |
|---|---|
| `SUP_BOC` · `SUP_IJC` · `SUP_CSM` · `SUP_CLB` · `SUP_MKM` · `SUP_EZC` · `SUP_CTK` · `SUP_RBM` · `SUP_JPS` · `SUP_NNN` · `SUP_BON` | `UNLINKED_PENDING_SUPPLIER_MIGRATION` |

⚠️ 이 문자열은 **문서상 상태 표현**일 뿐이다.
⛔ DB enum·status 컬럼으로 추가하지 않는다.

**`BOC`·`IJC`·`CSM`·`CLB`·`MKM`·`EZC`·`CTK`·`RBM`·`JPS`·`NNN`·`BON` 은 현재
warehouse/source 축약어다.** 이를 `Supplier.supplierCode` 로 **자동 승격하지
않는다.** 정본이 source 에 없으면 만들지 않으며, 이름 유사성만으로 FK 를 연결하지
않는다.

**향후 매칭 규칙** (Phase 7): 실제 migration source 의 Supplier source row ·
`supplierName` · original identifiers · source provenance 를 사용한다.
11건 모두 **exact 1:1** 이어야 하며, **0 match → block · 2+ match → block**.

---

## W-D39. BOC / BON

`SKU MASTER_부자재 등` r47(BOC)·r57(BON)이 모두 "본코스메틱" 이다
(`docs/00` Q-02).

- **T08 blocker 가 아니다.** Warehouse identity 는 `SUP_BOC`·`SUP_BON` **2개로
  보존**한다.
- 같은 Supplier 인지 다른 Supplier 인지 **T08 에서 결정하지 않는다** — Phase 7
  source evidence 로 결정한다.
- ⛔ 두 창고를 미리 합치지 않는다. 잘못 합치면 되돌리기 어렵다. 확인 결과 동일
  업체이면 재고 이동 조정거래로 병합한다(`docs/06 §12.8`).
- migration 시 `DataIssue(WAREHOUSE_NAME_DUPLICATE, WARNING)` 등록.

---

## W-D40. T09 경계

`T08-1`·`T08-2` 완료 후 T09/R1a-2 재고 코어가 사용할 **최소 contract**:

`Warehouse.id` · `WarehouseLocation.id` · `Warehouse.defaultLocationId`
**NOT NULL** · same-warehouse default invariant · `Warehouse.active` ·
`WarehouseType` · **DEFAULT location existence**.

T09 소유(이번 scope **0**): `InventoryLedgerEntry` · `InventoryBalance` ·
`InventoryPostingService` · current-stock provider.

---

## W-D41. `max-assembly-qty`

`GET /api/boms/{id}/max-assembly-qty` 는 **T08 이후에도 구현하지 않는다.**
Warehouse 가 생겼다고 현재고가 생기지 않는다.

unblock 판단 시점은 **실제 current-stock read capability**(`T10-1` 또는 동등한
current-balance service) landing 이후다. ⛔ `InventoryBalance` schema 만 생긴
시점에 자동 unblock 하지 않는다.

---

## W-D42. 향후 테스트 경계

**T08-1**: `WarehouseType` exact 6 · Warehouse/Location field exact ·
`warehouseCode` unique · location composite unique · `defaultLocationId`
NOT NULL · same-warehouse composite FK · deferrable constraint 카탈로그 확인 ·
staged 5 FK enforcement · supplier/externalSystem relation ·
**one-way** SUPPLIER_SITE CHECK · `IN_TRANSIT` max-one · FK action · drift.

**T08-2**: create transaction atomic · DEFAULT exact 값 · rollback ·
idempotency(first/replay/reused-key) · `IN_TRANSIT` public create 차단 ·
metadata PATCH · **`active` PATCH 400** · location create ·
**DEFAULT 수동 생성 차단** · 15 seed + 15 DEFAULT · **seed 11건 `supplierId`
null** · **fake Supplier 0** · permission · audit.

**Supplier migration 이후**: 11 link 전부 해소 · unlinked 0 · ambiguous mapping
실패 · **two-way CHECK 존재** · 그 이후 `SUPPLIER_SITE` + null **거부**.

`T2-20` 은 이번 테스트 범위가 아니다.

---

## superseded / clarified 목록

| 문서 | 조항 | 처리 |
|---|---|---|
| `docs/00` | **G-05** "생성 후 즉시 UPDATE" | **CLARIFIED** → W-D7 pre-generated UUID (목적은 유지) |
| `docs/03` | `Warehouse.defaultLocationId` nullable | **SUPERSEDED** → W-D5 NOT NULL |
| `docs/03` | `Warehouse.ledgerEntries`·`balances` | **DEFERRED** → W-D18 (T09) |
| `docs/05` | API 표 GET `"전체"` · §11.10 "조회 전체" | **SUPERSEDED** → W-D22 (§11.22 matrix) |
| `docs/05` | PATCH `active` lifecycle | **DEFERRED** → W-D27 (`T2-20`) |
| `docs/05` | `CreateWarehouseDto` 미정의 · PATCH body `—` | **CLOSED** → W-D24 · W-D26 |
| `docs/06` | §12.8 "Phase 7 후 연결 또는 Phase 3 선등록" | **CLARIFIED** → W-D13 staged link |
| `docs/07` v0.1 | `T08-3` 창고 화면 | **SUPERSEDED** → `T2-20` (W-D1) |
| `docs/07` v0.2 | `T2-1` | authoritative + legacy alias (W-D1) |
| `docs/12`·`17`·`18` | staged warehouse scalar | **T08-1 landing** → W-D15 |
| PRE-FLIGHT | `defaultLocationId` nullable 권장 | **REJECTED** → W-D5 |
| 직전 지시 §13 | T08 시점 two-way IFF CHECK | **SUPERSEDED** → W-D13 one-way |
