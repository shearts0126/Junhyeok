/**
 * BOM application (T07-2).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-13 · §D-22 · §D-28.
 *
 * ⚠️ 이 barrel 은 Prisma 런타임을 끌고 온다 — **클라이언트 번들에서 import 하지
 *    않는다** (T06 `supplier/application` 과 같은 경계).
 * ⛔ T07-2 는 REST route 를 만들지 않는다. 여기 있는 것은 T07-3/T07-5 가 호출할
 *    internal service 다.
 */

export {
  assertNoBomCycleForCandidate,
  buildBomCycleGraph,
  type AssertNoBomCycleForCandidateInput,
  type BomCycleCandidate,
  type BomCycleGraphSnapshot,
} from './cycle-graph';
export { bomNotFound, type BomDbClient, type BomReadClient } from './refs';
export {
  resolveEffectiveBom,
  resolveEffectiveBoms,
  type EffectiveBomHeaderRow,
  type ResolveEffectiveBomInput,
  type ResolveEffectiveBomsInput,
} from './resolve-effective-bom';
export {
  validateBomCandidateInTransaction,
  type ValidateBomCandidateInput,
} from './validate-candidate';
