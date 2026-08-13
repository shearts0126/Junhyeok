import { assertPermission, type ActorContext } from '@/modules/auth/application';

import { parseSupplierId } from './dto';
import { defaultSupplierClient, type SupplierReadDependencies } from './list-suppliers';
import { SUPPLIER_READ_PERMISSION } from './policy';
import { supplierNotFound } from './refs';
import { toSupplierView, type SupplierView } from './views';

/**
 * `GET /api/suppliers/{id}` — 거래처 단건 상세 (T06-4 supporting API, D-9·D-36).
 *
 * ⚠️ **2차 권한 가드.** `supplier.read` 를 재검사한다. ADMIN bypass 없음.
 *
 * ## 왜 T06-4 에서 추가하는가
 *
 * `docs/02:148` 이 `suppliers/[id]/` 상세 화면을 요구하는데, 목록 API 의 `q` 는
 * `supplierCode`·`supplierName` **contains 검색**뿐이라 **id exact lookup 이
 * 불가능**하다. 이 endpoint 없이는 `/master/suppliers/{id}` 의 새로고침·
 * deep-link·공유 URL·뒤로가기가 list cache 없이는 성립하지 않는다.
 * T05-4A 가 같은 이유로 `GET /api/external-systems` 를 supporting API 로 추가한
 * 선례를 따르며(docs/15 §5), T06-2 가 남긴 "T06-4 PRE-FLIGHT 에서 결정"
 * 유예(docs/17 §49)를 **T06-4 범위에 한해 supersede** 한다.
 *
 * ## 계약
 *
 *   - 응답은 **기존 `SupplierView` 를 그대로** 쓴다 — 별도 `SupplierDetailView`
 *     를 만들지 않는다. PATCH 응답과 같은 shape(`{supplier, requestId}`)다.
 *   - 없으면 **404** — 빈 객체로 위장하지 않는다.
 *   - **query parameter 를 받지 않는다** — 어떤 키든 들어오면 400 이다.
 *   - ⛔ AuditLog 없음(read-only) · 멱등 계약 없음 · 공급조건/가격 join 없음.
 */

export async function getSupplier(
  actor: ActorContext,
  rawSupplierId: string,
  dependencies: SupplierReadDependencies = {},
): Promise<SupplierView> {
  assertPermission(actor, SUPPLIER_READ_PERMISSION);
  const supplierId = parseSupplierId(rawSupplierId);

  const db = dependencies.db ?? (await defaultSupplierClient());

  const row = await db.supplier.findUnique({ where: { id: supplierId } });
  if (row === null) throw supplierNotFound(supplierId);

  return toSupplierView(row);
}
