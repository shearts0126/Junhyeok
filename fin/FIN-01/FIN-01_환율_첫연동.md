# FIN-01 첫 외부 연동 경로: 한국수출입은행 환율

- 상태: **실제 수집 대기(READY_FOR_REVIEW, 실수집 미검증).** 설계 담당자가 첫 외부 연동 검증 대상으로 지정한 소스이며, API 이용 가능성을 확정했다는 뜻이 아니다.
- 구현 위치: `fin/fin02a/src/collectors/koreaexim-fx.ts`(다섯 단계 수집기), `fin/fin02a/test/koreaexim-fx.test.ts`, 시험 응답 `fin/fin02a/samples/koreaexim-ap01-modeled.json`(가상). worker 레지스트리 키 `koreaexim-fx`.
- 근거 수준: 공식 페이지(https://www.koreaexim.go.kr/ir/HPHKIR020M01?apino=2&viewtype=C)와 공공데이터포털(https://www.data.go.kr/data/3068846/openapi.do)의 **검색 발췌**. 본 환경은 두 호스트 모두 차단되어 원문을 열람하지 못했다(확인일 2026-09-14). 아래 표의 "원문 확인 필요" 항목은 자격·네트워크가 있는 환경에서 첫 실수집 전에 원문으로 재확인해야 한다.

## 1. 공식 명세 확인 현황

| 항목 | 발췌로 확인 | 미확인(추정 구현 하지 않음) |
|---|---|---|
| 엔드포인트 | `https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=…&searchdate=YYYYMMDD&data=AP01` (신규 도메인, 구 도메인 병행 종료 2026-04-30) | — |
| 인증 | 인증키(authkey) 쿼리 파라미터. 인증키 즉시 발급, 2년 미사용 파기 | 키 재발급 절차, 이용약관 원문 |
| 응답 필드 | 배열 원소: `result`, `cur_unit`, `cur_nm`, `ttb`, `tts`, `deal_bas_r`, `bkpr`, `yy_efee_r`, `ten_dd_efee_r`, `kftc_deal_bas_r`, `kftc_bkpr` | 응답에 기준일 필드가 있는지(발췌에 없음 → 요청 searchdate 를 기준일로 보존하고 `asOfDateBasis='REQUESTED'` 표시) |
| USD 단위·환율 종류 | `cur_unit` 에 통화 코드(USD). 종류: 매매기준율(deal_bas_r), 전신환 매입/매도(ttb/tts), 장부가격(bkpr), 금융결제원 기준(kftc_*) | 100 단위 통화 표기 규칙(`JPY(100)` 등)의 공식 정의 → `cur_unit` 원문을 그대로 보존 |
| 조회 가능일·게시 시각 | 영업일 11시경 갱신 | 과거 조회 가능 기간 |
| 휴일·빈 응답 | 비영업일·게시 전에는 빈 배열로 알려짐(제3자 사례) | 공식 원문 미확인 → 빈 배열은 "0건 성공" 으로만 기록하고 전 영업일 값 대체 저장은 하지 않음(대체 규칙은 소비 측 설계) |
| 오류 처리 | `result` 1 성공, 2 DATA 코드 오류, 3 인증코드 오류, 4 일일 제한(1,000회) 초과 | 오류 시 HTTP 상태 코드 |
| 호출 제한·이용 조건 | 일 1,000회 | 상업적 이용 조건 원문 |

## 2. 구현한 경로(요청→파싱→정규화→원본 대조→저장)

| 단계 | 구현 | 실패 분류 |
|---|---|---|
| 인증 | `FIN01_KOREAEXIM_AUTHKEY` 환경변수만 읽음. 요청 URL 에만 사용, 저장·로그 없음(요청 요약은 템플릿 `GET /site/program/financial/exchangeJSON/{searchdate}/AP01`) | 없으면 BLOCKED/CREDENTIALS, 외부 요청 없음 |
| 요청 | 일 단위(searchdate). 기간이 여러 날이면 `MULTI_DAY_RANGE_NOT_IMPLEMENTED`(작업을 날짜별로 나눔) | 타임아웃·5xx·429 → TRANSIENT(재시도 대상), 403 → PERMANENT(프록시 차단·거부), 기타 → PERMANENT |
| 검증 | JSON 배열, 빈 배열=0건, `result` 코드 분기, `cur_unit` 필수 | 3 → CREDENTIALS, 4 → PERMANENT(오늘 재시도 무의미), 2 → PERMANENT, JSON 아님 → PARSE_FAILED(원본 보관) |
| 정규화 | 통화 행 × 제공된 환율 종류별로 관측 1건. 원천키 `YYYY-MM-DD|cur_unit|종류`, payload `{source, currencyUnit, currencyName, asOfDate, asOfDateBasis, rateType, value(콤마 제거 문자열), rawValue}`. 부동소수점 변환 없음, 미제공 종류는 만들지 않음(0 대체 금지) | 값 형식 오류 → PERMANENT |
| 대조 | 통화 행 수 = 원본 건수, 통화 중복 없음, 제공 종류 수 = 정규화 건수 | 불일치 → RECONCILE_MISMATCH(관측 미저장) |
| 저장 | 기존 관측·버전 처리(동일 응답 재수집 시 버전 증가 없음) | — |

환율은 통화·기준일·환율 종류·값·출처로 구분해 저장한다. 대시보드에서 쓸 최종 환율 종류 선택과 은행 현금 환산 연결은 하지 않았다(설계 담당자 결정 대상).

## 3. 검증 결과 구분

| 구분 | 결과 |
|---|---|
| 발췌 기준 가상 응답 시험(`test/koreaexim-fx.test.ts` 4건) | 통과: 3통화×6종류=18건 정규화·대조·저장, 인증키 미잔존, 재수집 무증가, 빈 배열 0건, result 코드 분기, HTTP 오류 분류, 다중 일자 미구현 표시 |
| 실수집 | **미검증.** 인증키 없음, 본 환경 egress 차단(`oapi.koreaexim.go.kr` 프록시 403 확인) |

## 4. 다음 조치(사용자·설계 담당자)

1. 회사 명의로 수출입은행 인증키 1종 발급(무료) 후 승인된 실행 환경의 `FIN01_KOREAEXIM_AUTHKEY` 에 설정. 다른 환율 키를 동시에 요구하지 않는다.
2. 그 환경에서 `pnpm enqueue --collector koreaexim-fx --mode VERIFICATION --from <영업일> --to <같은 날> --request-id fx-verify-1` 후 worker 로 처리하고 실행·원본·관측 결과를 제출. 원문 명세와의 차이(기준일 필드 유무, 빈 응답 형태, 100 단위 표기)를 그때 확정.
3. 첫 실수집이 원문 명세와 다르면 대체 공급자(ECOS 등) 검토 여부를 보고한다. 현재는 대체가 필요하다고 판단할 근거가 없다.
