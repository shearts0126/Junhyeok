# 도메인 모듈

각 모듈은 다음 4계층 구조를 따른다 (설계 문서 `docs/02_시스템_아키텍처와_모듈구조.md` §4.4).

```
src/modules/<module>/
├─ domain/            엔티티·값객체·불변식·상태전이. 순수 함수, DB·프레임워크 의존 없음
│  ├─ entities/
│  ├─ rules/
│  └─ errors/
├─ application/       유스케이스. 트랜잭션 경계. 권한 검사. 감사로그 기록
│  ├─ commands/
│  ├─ queries/
│  └─ ports/
├─ infrastructure/    Prisma 리포지토리 구현, 외부 어댑터
└─ presentation/      Zod DTO, Route Handler, Server Action, 화면 컴포넌트
```

## 규칙

1. 비즈니스 로직을 React 컴포넌트나 Route Handler에 직접 작성하지 않는다.
2. 모듈 간 호출은 `application/` 의 공개 인터페이스를 통한다.
   다른 모듈의 `infrastructure/` 나 Prisma 모델을 직접 참조하지 않는다.
3. 상위 Layer는 하위 Layer만 참조한다. 역방향 참조 금지.
4. `inventory-ledger` 모듈은 어떤 상위 모듈도 참조하지 않는다.
5. 재고를 변경하는 모든 경로는 `InventoryPostingService` 를 통과한다.

## 도입 예정 모듈

| Layer | 모듈 | 작업 |
|---|---|---|
| 0 | `identity`, `common-code`, `audit` | T0-6 ~ T0-8 |
| 1 | `sku`, `barcode`, `external-mapping` | R1a-1 |
| 1 | `supplier`, `warehouse` | R1a-2 / R1a-3 |
| 2 | `bom` | R1a-3 |
| 3 | `inventory-ledger`, `inventory-balance`, `inventory-status` | R1a-2 |
| 4 | `reservation`, `adjustment`, `stock-count`, `inventory-close` | R1b |
| 5 | `external-snapshot`, `reconciliation`, `data-import`, `issue` | R1a-4 / R1b |

> T0-1 시점에는 모듈이 없다. 첫 모듈은 R1a-0 T0-6(`identity`)에서 생성한다.
