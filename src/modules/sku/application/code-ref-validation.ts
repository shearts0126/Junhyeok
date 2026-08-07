import { findCommonCodeRefs, type CommonCodeRefClient } from '@/modules/common-code/application';
import { ValidationError } from '@/shared/errors';

/**
 * SKU 의 공통코드 참조 검증 (T1-3) — T1-1 limitation 해소.
 *
 * DB FK 는 존재성만 보장한다. 여기서 application 검증으로:
 *   ① 존재  ② **group 정체성** (brandId → BRAND 등)  ③ 신규 참조는 active=true
 * 를 추가한다.
 *
 * - CommonCode infrastructure 직접 import 없음 — 공개 query(`findCommonCodeRefs`)만 사용.
 * - trigger·group 중복 컬럼 없음.
 * - `null` 은 참조 해제이므로 검증 대상이 아니다.
 * - ⛔ MAJOR ↔ MINOR 의 parent-child 조합 검증은 하지 않는다 — 원본 코드사전에
 *   고정 계층이 없음을 T0-8 에서 확인했다. group 정체성만 본다.
 */

const EXPECTED_GROUPS = {
  brandId: 'BRAND',
  majorCategoryId: 'MAJOR_CATEGORY',
  minorCategoryId: 'MINOR_CATEGORY',
} as const;

export type CodeRefField = keyof typeof EXPECTED_GROUPS;

export interface CodeRefPatch {
  readonly brandId?: string | null | undefined;
  readonly majorCategoryId?: string | null | undefined;
  readonly minorCategoryId?: string | null | undefined;
}

/**
 * 새로 설정되는(값이 제공되고 null 이 아닌) 참조만 검증한다.
 * 기존 SKU 가 이미 비활성 코드를 참조 중이어도, PATCH 가 그 필드를 건드리지
 * 않으면 다른 필드 수정을 막지 않는다.
 *
 * @throws {ValidationError} 존재하지 않음 / 그룹 불일치 / 비활성 코드 신규 선택
 */
export async function assertValidCodeRefs(
  client: CommonCodeRefClient,
  patch: CodeRefPatch,
): Promise<void> {
  const targets = (Object.keys(EXPECTED_GROUPS) as CodeRefField[])
    .map((field) => ({ field, id: patch[field] }))
    .filter((entry): entry is { field: CodeRefField; id: string } => typeof entry.id === 'string');

  if (targets.length === 0) return;

  const refs = await findCommonCodeRefs(
    client,
    targets.map((target) => target.id),
  );
  const byId = new Map(refs.map((ref) => [ref.id, ref]));

  const fieldErrors: Array<{ path: string; message: string }> = [];
  for (const { field, id } of targets) {
    const expectedGroup = EXPECTED_GROUPS[field];
    const ref = byId.get(id);

    if (ref === undefined) {
      fieldErrors.push({ path: field, message: '존재하지 않는 공통코드입니다.' });
      continue;
    }
    if (ref.groupCode !== expectedGroup) {
      // ⚠️ 다른 그룹의 실존 코드 ID 를 넣는 경우 — DB FK 는 통과하므로 여기서 막는다.
      fieldErrors.push({
        path: field,
        message: `'${expectedGroup}' 그룹의 코드여야 합니다. (현재: '${ref.groupCode}')`,
      });
      continue;
    }
    if (!ref.active) {
      fieldErrors.push({
        path: field,
        message: '비활성 공통코드는 새로 선택할 수 없습니다.',
      });
    }
  }

  if (fieldErrors.length > 0) {
    throw new ValidationError(fieldErrors, { message: '공통코드 참조가 올바르지 않습니다.' });
  }
}
