import { SKU_DETAIL_TABS, type SkuDetailTabKey } from '../sku-form-fields';

/**
 * SKU 상세 탭 노출·fallback 규칙 — **순수 함수**다 (T1-6B4 remediation R2-6).
 *
 * `SkuDetailClient` 안에 인라인으로 있던 두 줄을 그대로 꺼냈다. 동작은 한 글자도
 * 바뀌지 않았고, 목적은 **권한 상실 시 fallback 을 브라우저 없이 고정**하는 것이다.
 *
 * ## 왜 Playwright 가 아니라 여기인가
 *
 * `usePermissions()` 는 mount 시 `/api/me` 를 **한 번** 부르고 다시 부르지 않으며,
 * 선택된 탭(`tab`)은 component state 라 remount 하면 `basic` 으로 초기화된다.
 * 즉 "탭을 고른 뒤 권한이 사라지는" 전이는 브라우저 세션 안에서 재현할 수단이
 * 없다 — 재현하려면 권한 refetch 를 새로 만들거나 role matrix 를 실행 중에
 * 흔들어야 하는데, 둘 다 이 작업 범위 밖이고 다른 spec 을 오염시킨다.
 * 그래서 **이 규칙만 순수 함수로 분리해 단위 테스트로 고정**한다.
 *
 * ⛔ 권한 판정은 **permission key** 로만 한다 — role 이름을 보지 않는다.
 * ⛔ `permissions === null`(아직 로딩 중)은 "없음"으로 본다 — 잠깐이라도 보였다가
 *    사라지는 탭을 만들지 않는다.
 */

export interface SkuDetailTabPermissions {
  /** `/api/me` 응답. 아직 로딩 중이면 `null`. */
  readonly permissions: readonly string[] | null;
}

function has(permissions: readonly string[] | null, key: string): boolean {
  return permissions?.includes(key) ?? false;
}

/**
 * 탭마다 요구 capability 가 다르다 — `sku.read` 로 대신 판단하지 않는다.
 *
 * ★ ⑥ 공급조건 탭은 `supplier.read` **AND** `supplier_price.read` 둘 다 필요하다
 *   (T1-6B4 D-4) — 응답에 공급조건과 **가격**이 함께 들어가기 때문이다.
 */
export function visibleSkuDetailTabs({
  permissions,
}: SkuDetailTabPermissions): readonly (typeof SKU_DETAIL_TABS)[number][] {
  return SKU_DETAIL_TABS.filter((entry) => {
    if (entry.key === 'barcode') return has(permissions, 'barcode.read');
    if (entry.key === 'externalMapping') return has(permissions, 'external_mapping.read');
    if (entry.key === 'supplier')
      return has(permissions, 'supplier.read') && has(permissions, 'supplier_price.read');
    return true;
  });
}

/** 노출 목록에 없는 탭이 선택돼 있으면 `basic` 으로 되돌린다. */
export function resolveActiveSkuDetailTab(
  requested: SkuDetailTabKey,
  visible: readonly { readonly key: SkuDetailTabKey }[],
): SkuDetailTabKey {
  return visible.some((entry) => entry.key === requested) ? requested : 'basic';
}
