/**
 * BOM 도메인 공용 상수 (T07-2).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-13 · §D-18.
 */

/**
 * BOM 전개·순환 탐지의 최대 깊이.
 *
 * ★ `docs/18 §D-13` 이 **`05:132` explode 기본값과 같은 상수를 공유한다**고
 *   확정했다. T07-6 explode 의 `maxLevel` 기본값도 이 값을 쓴다 —
 *   ⛔ 숫자 `10` 을 다른 production 파일에 다시 적지 않는다.
 *
 * ⛔ 이 깊이를 넘었을 때 **조용히 traversal 을 끝내고 "순환 없음"으로 판정하지
 *    않는다.** `BOM_MAX_LEVEL_EXCEEDED` 를 던진다 (§D-13·§D-29).
 */
export const BOM_MAX_LEVEL = 10;
