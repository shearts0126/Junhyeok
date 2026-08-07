/**
 * 공통코드 Application Layer (T0-8).
 *
 * ⛔ 물리삭제 함수가 없다. "삭제" = `updateCode(..., { active: false })`.
 */
export { CODE_MANAGE_PERMISSION, CODE_READ_PERMISSION } from './policy';
export {
  parseActiveFilter,
  parseCreateCodeInput,
  parseUpdateCodePatch,
  UPDATABLE_CODE_FIELDS,
  type ActiveFilter,
  type CreateCodeInput,
  type UpdateCodePatch,
} from './parse';
export {
  listCodeGroups,
  listCodes,
  groupNotFound,
  type CommonCodeListDependencies,
  type CommonCodeReadClient,
} from './list-codes';
export {
  createCode,
  updateCode,
  jsonEquals,
  type CommonCodeMutateDependencies,
} from './mutate-codes';
export { toCodeView, type CodeGroupView, type CodeParentView, type CodeView } from './views';
export { findCommonCodeRefs, type CommonCodeRef, type CommonCodeRefClient } from './code-refs';
