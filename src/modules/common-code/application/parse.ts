import { ValidationError } from '@/shared/errors';

/**
 * 공통코드 API 입력 검증 (T0-8).
 *
 * - 알 수 없는 필드 거부
 * - `code`·`name` 은 trim 후 빈 값 차단
 * - 수정 불가 필드(`id`·`groupCode`·`code`·`createdAt`·`createdBy`·`updatedAt`·
 *   `updatedBy`)는 PATCH 본문에 오면 명시적으로 거부한다 — "알 수 없는 필드"가
 *   아니라 "수정할 수 없는 필드"라고 알려야 클라이언트가 원인을 찾는다.
 */

export interface CreateCodeInput {
  readonly code: string;
  readonly name: string;
  readonly parentCode: string | null;
  readonly sortOrder: number;
  readonly attributes: Record<string, unknown> | null;
}

export interface UpdateCodePatch {
  readonly name?: string;
  /** `null` 이면 부모 연결 해제 */
  readonly parentCode?: string | null;
  readonly sortOrder?: number;
  readonly attributes?: Record<string, unknown> | null;
  readonly active?: boolean;
}

interface FieldError {
  path: string;
  message: string;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError([{ path: 'body', message: 'JSON 객체가 필요합니다.' }]);
  }
  return body as Record<string, unknown>;
}

/** JSONB 로 저장할 수 있는 평면 객체인가. 배열·원시값은 거부한다. */
function isAttributesObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSortOrder(raw: Record<string, unknown>, errors: FieldError[]): number | undefined {
  if (!('sortOrder' in raw)) return undefined;
  const value = raw['sortOrder'];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    errors.push({ path: 'sortOrder', message: '0 이상의 정수여야 합니다.' });
    return undefined;
  }
  return value;
}

function readParentCode(
  raw: Record<string, unknown>,
  errors: FieldError[],
): string | null | undefined {
  if (!('parentCode' in raw)) return undefined;
  const value = raw['parentCode'];
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({ path: 'parentCode', message: '문자열 코드 또는 null 이어야 합니다.' });
    return undefined;
  }
  return value.trim();
}

function readAttributes(
  raw: Record<string, unknown>,
  errors: FieldError[],
): Record<string, unknown> | null | undefined {
  if (!('attributes' in raw)) return undefined;
  const value = raw['attributes'];
  if (value === null) return null;
  if (!isAttributesObject(value)) {
    errors.push({ path: 'attributes', message: 'JSON 객체 또는 null 이어야 합니다.' });
    return undefined;
  }
  return value;
}

const CREATE_FIELDS = new Set(['code', 'name', 'parentCode', 'sortOrder', 'attributes']);

export function parseCreateCodeInput(body: unknown): CreateCodeInput {
  const raw = asObject(body);
  const errors: FieldError[] = [];

  for (const key of Object.keys(raw)) {
    if (!CREATE_FIELDS.has(key)) {
      errors.push({ path: key, message: '알 수 없는 필드입니다.' });
    }
  }

  let code = '';
  if (typeof raw['code'] !== 'string' || raw['code'].trim() === '') {
    errors.push({ path: 'code', message: '코드는 비어 있지 않은 문자열이어야 합니다.' });
  } else {
    code = raw['code'].trim();
  }

  let name = '';
  if (typeof raw['name'] !== 'string' || raw['name'].trim() === '') {
    errors.push({ path: 'name', message: '명칭은 비어 있지 않은 문자열이어야 합니다.' });
  } else {
    name = raw['name'].trim();
  }

  const parentCode = readParentCode(raw, errors) ?? null;
  const sortOrder = readSortOrder(raw, errors) ?? 0;
  const attributes = readAttributes(raw, errors) ?? null;

  if (errors.length > 0) {
    throw new ValidationError(errors, { message: '코드 생성 요청이 올바르지 않습니다.' });
  }

  return { code, name, parentCode, sortOrder, attributes };
}

/** PATCH 로 바꿀 수 있는 필드. */
export const UPDATABLE_CODE_FIELDS = [
  'name',
  'parentCode',
  'sortOrder',
  'attributes',
  'active',
] as const;

/** 존재하지만 PATCH 로 바꿀 수 없는 필드. 요청에 오면 명시적으로 거부한다. */
const IMMUTABLE_CODE_FIELDS = new Set([
  'id',
  'groupCode',
  'groupId',
  'code',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
]);

export function parseUpdateCodePatch(body: unknown): UpdateCodePatch {
  const raw = asObject(body);
  const errors: FieldError[] = [];
  const allowed = new Set<string>(UPDATABLE_CODE_FIELDS);

  for (const key of Object.keys(raw)) {
    if (allowed.has(key)) continue;
    if (IMMUTABLE_CODE_FIELDS.has(key)) {
      errors.push({ path: key, message: '수정할 수 없는 필드입니다.' });
    } else {
      errors.push({ path: key, message: '알 수 없는 필드입니다.' });
    }
  }

  const patch: Record<string, unknown> = {};

  if ('name' in raw) {
    if (typeof raw['name'] !== 'string' || raw['name'].trim() === '') {
      errors.push({ path: 'name', message: '명칭은 비어 있지 않은 문자열이어야 합니다.' });
    } else {
      patch['name'] = raw['name'].trim();
    }
  }

  if ('active' in raw) {
    if (typeof raw['active'] !== 'boolean') {
      errors.push({ path: 'active', message: 'true 또는 false 여야 합니다.' });
    } else {
      patch['active'] = raw['active'];
    }
  }

  const parentCode = readParentCode(raw, errors);
  if (parentCode !== undefined) patch['parentCode'] = parentCode;
  const sortOrder = readSortOrder(raw, errors);
  if (sortOrder !== undefined) patch['sortOrder'] = sortOrder;
  const attributes = readAttributes(raw, errors);
  if (attributes !== undefined) patch['attributes'] = attributes;

  if (Object.keys(patch).length === 0 && errors.length === 0) {
    errors.push({ path: 'body', message: '변경할 필드를 최소 하나 지정하세요.' });
  }

  if (errors.length > 0) {
    throw new ValidationError(errors, { message: '코드 수정 요청이 올바르지 않습니다.' });
  }

  return patch as UpdateCodePatch;
}

export type ActiveFilter = 'true' | 'false' | 'all';

/** `?active=` 쿼리. 기본값은 `'true'`(활성만). */
export function parseActiveFilter(value: string | null): ActiveFilter {
  if (value === null || value === 'true') return 'true';
  if (value === 'false' || value === 'all') return value;
  throw new ValidationError([
    { path: 'active', message: "'true' | 'false' | 'all' 중 하나여야 합니다." },
  ]);
}
