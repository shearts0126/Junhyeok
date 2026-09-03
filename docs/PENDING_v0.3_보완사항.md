# 설계 v0.3 보완 대기 목록

> v0.2 승인 시 사용자가 지시한 필수 보완사항. 각 항목의 **확정 기한 전에** 설계에 반영하고 재승인을 받는다.
> 현재 상태: **미반영 (T0-2 완료 시점)**

## 확정 기한

| 기한 | 항목 | 비고 |
|---|---|---|
| **`T0-7` 착수 전** | **6번** (자가승인 설정 분리) | `T0-7` 이 `system_setting` 모델·API 를 만들므로 설정 키 구조가 먼저 확정되어야 한다 |
| **`T1-11` 착수 전** | **7번** (동기 업로드 조건) | `T1-11` 이 SKU 엑셀 업로드를 구현하므로 동기/CLI 방식 판단이 먼저 필요하다 |
| **`R1a-2` 착수 전** | **1~5번** | 재고 코어(Posting Service) 설계에 직접 반영되는 항목. ✏️ **5번은 `T2-7` 에서 확정**(2026-09-03) |

> **`T0-2` ~ `T0-6` 은 위 항목의 선행조건이 아니다.** 해당 구간은 보완 없이 진행 가능하다.

| # | 항목 | 대상 문서 | 영향 작업 | 확정 기한 |
|---|---|---|---|---|
| **1** | **SKU 단위 상시 음수재고 허용 금지** — `sku.negativeStockAllowed`만으로 음수를 허용하는 경로 제거. 거래마다 승인된 예외요청이 있을 때만 허용 (승인상태 `APPROVED` / 승인자 `ADMIN`·`SCM_LEADER` / 실행자≠승인자 / SKU·창고·허용수량·유효기간이 거래와 일치 / 사유 필수 / 사용 이력·감사로그) | `03`(예외요청 모델 신설), `04 §8.6` | `T2-9`, `T2-14` | R1a-2 착수 전 |
| **2** | **승인자 ID 직접 입력 금지** — `PostingCommand.approvedBy` 문자열 신뢰 제거. `allowNegativeStock: { approvalRequestId }` / `allowClosedPeriod: { approvalRequestId }` 로 변경하고, **같은 DB 트랜잭션 안에서** 승인자 권한·승인 상태·작성자 분리·승인 범위·유효기간을 재검증 | `04 §8.1`, `§8.6`, `§8.12` | `T2-5`, `T2-9`, `T2-14` | R1a-2 착수 전 |
| **3** | **멱등 요청 해시** — `inventory_transaction.request_hash` 추가. 동일 idempotency key + 동일 hash → 기존 결과 반환 / 동일 key + 다른 hash → **`409 IDEMPOTENCY_KEY_REUSED`**. hash는 정규화된 거래유형·원인문서·외부키·entries·사유 기준. **entry 순서만 다른 요청을 동일 요청으로 볼지 정책 명시 필요** | `03`(컬럼 추가), `04 §8.8`, `05 §10.18` | `T2-11` | R1a-2 착수 전 |
| **4** | **net=0 그룹 처리** — 원장행은 원본대로 저장하되 `inventory_balance`를 **갱신하지 않고 0수량 행도 생성하지 않는다**. `last_transaction_id`를 **"마지막으로 실제 수량이 변경된 거래"** 로 정의 (v0.2는 net=0도 갱신하도록 설계했으므로 수정 필요) | `03 §7`, `04 §8.7`, `§8.12` | `T2-9` | R1a-2 착수 전 |
| **5** | ✅ **확정 (T2-7 반영)** — **거래유형별 균형 검증 (Validation Strategy 분리)**. 단순 전체 합계 0 검증을 폐기하고 거래유형 family 별 balance-key 단위로 균형을 본다.<br>· `STATUS_CHANGE`·`RESERVATION`·`RESERVATION_RELEASE`: **7열**(`skuId`·`warehouseId`·`locationId`·`lotNo`·`expiryKey`·`serialNo`·`ownerCode` — 재고키 8열 − `inventoryStatus`) 단위 `Σ netQuantityDelta = 0`<br>· `WAREHOUSE_TRANSFER_OUT`·`WAREHOUSE_TRANSFER_IN`: **5열**(7열 − `warehouseId`·`locationId`) 단위 `Σ netQuantityDelta = 0`. `00 §C-02` 가 **한 leg = 한 거래 = 두 원장행**으로 확정했으므로 이 균형은 단일 거래 안에서 계산된다<br>· `ASSEMBLY`·`DISASSEMBLY`: 전체 합계 0 요구하지 않음 — **면제**<br>· 일반 입고·출고·조정: 균형 검증 대상 아님 — **면제**<br>구현: `src/modules/inventory/domain/status-transition.ts` `assertBalancedIfStatusMove()`. `04 §8.4` 규칙 5 는 `SUPERSEDED`, `§8.12` 의사코드도 함께 정정했다. | `04 §8.4`, `§8.12` | `T2-7` | ~~R1a-2 착수 전~~ → **확정** |

> ✏️ **§5 잔여 ownership (2026-09-03, T2-7)** — `ASSEMBLY`·`DISASSEMBLY` 의 **조립지시서 + BOM 기준 실제 검증** 구현은 **R3(세트조립·해체 실행)** scope 가 소유한다(`00 v0.2 §1.4` *"세트조립·해체 **실행** | BOM 전개·조립가능수량 **조회**는 R1a-3 | R3"*). R3 은 아직 task 로 분해되어 있지 않으므로 **exact task 번호가 없으며 ⛔ 새 T-number 를 발명하지 않는다.** `T2-7` 은 §5 가 요구한 **generic balance exemption 까지만** 반영한다 — `AssemblyOrder` 모델 · assembly validation port · BOM validator 전부 **0** 이며, R1a-2 에 호출자가 없는 port 를 미리 만들지 않는다.
>
> 이것은 **§5 미해결을 뜻하지 않는다.** §5 가 요구한 것은 *validation strategy 의 분리*이고 그 전략(어느 거래유형이 어떤 key 단위로 균형을 보는가, 어느 유형이 면제인가)은 네 bullet 전부 확정되어 `T2-7` 이 구현했다. 남은 것은 R3 의 **구현**이지 미결 설계가 아니다 — `§6` 이 영향작업(`T3-9`)이 남은 상태에서 `✅ 확정` 을 받은 것과 같은 판단이다.
>
> 마찬가지로 두 창고이동 거래(`_OUT` ↔ `_IN`) **사이**의 `도착 ≤ 출발` 불변식은 §5 의 균형 검증이 아니라 **`T2-9` ⑭ 음수재고 검증**(`IN_TRANSIT` 버킷 음수)이 소유한다.
| **6** | ✅ **확정 (T0-7 반영)** — 전역 `allow_self_approval` 을 **`allow_self_approval_sku`** / **`allow_self_approval_bom`** 두 설정으로 분리. 재고조정 승인·음수재고 예외 승인·월마감 해제는 **설정과 무관하게 항상 금지**하며 ADMIN 도 예외가 없다. 일반 `allow_self_approval` 컬럼은 만들지 않는다. | `03 §7`, `05 §10.1`, `00 §15 D-07` | `T0-7`, `T1-4`, `T3-9` | ~~`T0-7` 착수 전~~ → **확정** |
| **7** | **동기 업로드 조건** — SKU 490행·BOM 383행 동기 업로드는 다음 전부 충족 시에만 사용: ① 전체 행 검증 후 반영 ② bulk insert/upsert ③ **일부 성공 금지** ④ 중복 재실행 안전 ⑤ 실행시간 초과 시 미반영 ⑥ 처리시간 테스트 포함.<br>웹 함수 실행시간을 안정적으로 충족하지 못하면 **R1a-1·R1a-3은 관리자용 마이그레이션 명령(CLI)으로 제공**하고 웹 비동기 업로드는 R1a-4에서 구현 | `05 §10.4`·`§10.8`, `07 T1-11`·`T3-12` | `T1-11`, `T3-12` | **`T1-11` 착수 전** |

## 반영 절차

```
T0-1 ✅ → T0-2 ✅ → T0-3 → T0-4 → T0-5 → T0-6
                                            ↓
                              [6번 확정 + 재승인]  ← system_setting 설정 키 구조
                                            ↓
                                          T0-7 → T0-8 → T0-9   (R1a-0 완료)
                                            ↓
                              R1a-1 T1-1 ~ T1-10
                                            ↓
                              [7번 확정 + 재승인]  ← 동기 업로드 vs CLI 판단
                                            ↓
                                          T1-11 ~ T1-15   (R1a-1 완료)
                                            ↓
                              [1~5번 설계 v0.3 반영 + 재승인]
                                            ↓
                                          R1a-2 착수
```
