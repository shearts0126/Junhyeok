# FIN-01 필드매핑표

- 목적: 계획서 §4 "최소 필수 필드" 와 §5 표준 테이블을 원천 필드로 충족할 수 있는지 확인한다. 새 데이터 모델을 설계하지 않는다.
- 근거 수준: `CONFIRMED`(공식 원문/실제 응답) · `SNIPPET`(공식 문서 검색 발췌, 원문 미열람) · `ASSUMED`(문서 미확인, 자리표시자) · `UNVERIFIED`(제공 여부 자체를 확인하지 못함. "미지원" 아님) · `MISSING`(미제공을 공식 근거로 확인 → 대체 규칙 필요). 확인일 2026-09-14. 이번 검증에서 `MISSING` 으로 확정한 항목은 없다.
- 이 표의 원천 필드명은 운영용 확정 스키마가 아니다. `ASSUMED`·`UNVERIFIED` 항목은 실제 응답 확보 전까지 추정값이다.
- 코드 대응: `verify/sources/*.ts` 의 `spec.mappings` 가 이 표와 1:1 이며 `results/fixture-run.json` 의 `mappingSummary` 에 집계된다.
- 전 출처에서 `CONFIRMED` 는 상수·사용자 확인 사항뿐이다. **실제 응답으로 확인된 필드는 없다.**

## 1. 은행 → bank_transactions / bank_balances

### 1.1 금융결제원 오픈뱅킹(거래내역조회·잔액조회)

| 표준 필드(§5) | 원천 필드 | 의미 | 변환 | 누락 여부 | 근거 |
|---|---|---|---|---|---|
| 법인/계좌/통화 | `fintech_use_num` | 핀테크이용번호(계좌 등록 시 발급) | external_mappings(핀테크이용번호→법인·은행·계좌별칭·통화). 통화는 응답에 없어 등록 정보로 고정 | 통화 필드 없음 | SNIPPET |
| 거래 ID 또는 대체 식별 | 발췌 필드 목록에서 미발견 | `bank_tran_id`/`api_tran_id` 는 호출 단위로 발췌. 거래별 ID 부재는 원문 미확인 | 부재 시 대체키 안 = (핀테크이용번호, `tran_date`, `tran_time`, `inout_type`, `tran_amt`, `after_balance_amt`, 페이지 내 순번) | 확인하지 못함(추정 대체키) | UNVERIFIED |
| 거래일시 | `res_list[].tran_date` + `tran_time` | YYYYMMDD, HHmmss(KST) | `yyyymmddHhmmssToLocal` → Asia/Seoul → UTC 병행 저장 | 없음 | SNIPPET |
| 입출금액 | `res_list[].inout_type`, `tran_amt` | 입금/출금 구분, 금액(원, 정수 문자열) | `입금`→IN, `출금`→OUT. 값 목록 원문 확인 필요 | 없음 | SNIPPET |
| 기준일 잔액 | `res_list[].after_balance_amt` / `balance_amt` | 거래 후 잔액 / 조회 시점 잔액(발췌) | 일자 지정 잔액 조회의 존재 여부 원문 미확인. 확인 전 안: 전일 마지막 `after_balance_amt` 로 유도, `balance_amt` 는 `AT_INQUIRY` 로 구분 저장 | 일자 기준 잔액 제공 여부 확인하지 못함 | SNIPPET(필드) / UNVERIFIED(일자 지정 조회) |
| 적요 | `res_list[].print_content` | 통장인자내용 | 그대로. 발췌에 `printed_content` 표기도 있어 정확한 키 원문 확인 필요 | 없음 | SNIPPET |
| 페이지네이션 | `page_record_cnt`, `next_page_yn`, `befor_inquiry_trace_info` | 페이지당 최대 25건 | `next_page_yn=Y` 면 trace 를 넘겨 재호출. 마지막 페이지 N 확인 전 완료 처리 금지 | — | SNIPPET |
| USD 계좌 | — | 외화계좌 지원 여부 | — | 확인하지 못함(미지원 단정 아님) | UNVERIFIED |

### 1.2 웹케시 브랜치 / CODEF / 하이픈(설정 기반)

| 표준 필드 | 원천 필드 | 비고 | 근거 |
|---|---|---|---|
| 법인/계좌/통화, 거래 ID, 거래일시, 입출금액, 거래후잔액, 적요, 기준일 잔액 | 전부 미확인 | `verify/sources/bank-aggregator.ts` 의 `AggregatorColumnConfig` 에 실제 컬럼명을 넣으면 매핑이 동작한다. 자리표시자 컬럼(`acct_no`, `ccy`, `tr_date`, `tr_time`, `in_amt`, `out_amt`, `bal_after`, `memo`)은 원천 명세가 아니다 | ASSUMED |
| 과거 조회 기간, 갱신 지연, 호출 제한, 요금 | — | 영업 문의 필요 | ASSUMED |

## 2. 소비자 매출 → sales_events

### 2.1 사방넷(자리표시자, 전부 ASSUMED)

| 표준 필드(§4·§5) | 원천 필드(자리표시자) | 변환·규칙 | 누락 여부 |
|---|---|---|---|
| 법인 | 사방넷 계정(연동키) | 계정→법인 매핑. 한 계정에 두 법인 몰이 섞이면 몰 ID 별 매핑 | 미확인 |
| 채널 | `mall_id` | 몰 코드→channels | 미확인 |
| 주문/항목 ID | `mall_order_id` / `order_line_id` | 행 단위 고유키가 사방넷 주문번호인지 몰 주문번호인지 확인 필요 | 미확인 |
| 결제 완료 일시 | `pay_date` | **결제 완료 일시 제공 여부가 핵심.** 주문일만 제공되면 계획서 기준(결제 완료)과 불일치 → 차이 명시 필요 | 미확인 |
| 이벤트 유형 | `order_status` | 결제완료→PAID, 취소/부분취소→CANCELLED, 환불→REFUNDED, 구매확정→이벤트 생성 안 함(IGNORE) | 상태코드표 미확인 |
| 금액·할인·세금 | `pay_amount` | 공급가/세포함, 할인·배송비 포함 여부 미확인 → `amountBasis=UNKNOWN` | 미확인 |
| 상품 코드 | `product_code` | 사방넷 코드 vs 몰 코드 확인. 미매핑은 원본 보존 | 미확인 |
| 부분취소/분할환불 | — | 별도 행인지 원행 상태 변경인지 확인. 후자면 관측 버전 비교로 이벤트 생성 | 미확인 |
| 변경 조회 | — | 수정일 파라미터 없으면 최근 7일 전체 재조회 | 미확인 |

### 2.2 카페24 Admin API(orders)

| 표준 필드 | 원천 필드 | 변환·규칙 | 근거 |
|---|---|---|---|
| 채널 | 상수 `OWNMALL_CAFE24` | — | CONFIRMED |
| 주문/항목 ID | `order_id` / `items[].order_item_code` | 원문 확인 필요 | ASSUMED |
| 결제 완료 일시 | `payment_date`(`paid=T`) | ISO 8601. 입금전(`paid=F`) 제외 | ASSUMED(날짜 형식만 SNIPPET) |
| 취소/환불 | `canceled`, `items[].order_status` | 상태 코드 체계·환불 확정일 필드 원문 확인 필요. 확인 전 취소일을 임의 대체하지 않음(`UNKNOWN`) | ASSUMED |
| 금액 | `items[].product_price × quantity` − 할인 | 공급가/세포함·할인·배송비 필드 원문 확인 필요 | ASSUMED |
| 상품 코드 | `items[].product_code` | — | ASSUMED |
| 인증·갱신 | OAuth2 액세스 2h / 리프레시 2주 | 갱신 스케줄 필수 | SNIPPET |
| 호출 제한 | Leaky Bucket, `x-ratelimit-remaining` | 버킷 크기 원문 확인 | SNIPPET |

## 3. 납품 매출(엑셀) → sales_events(saleType=DELIVERY)

| 표준 필드 | 가정 컬럼 | 규칙 | 근거 |
|---|---|---|---|
| 법인 | `법인` | 명시적 매핑, 미매핑은 UNMAPPED | ASSUMED |
| 거래처(채널) | `거래처` | 거래처 외부 코드→counterparties | ASSUMED |
| 출고번호·행 | `출고번호`, `행번호` | 고유키 (법인, 출고번호, 행번호, 반품여부). 출고번호 없으면 파일/시트/행 식별 + 중복 후보 검토 | ASSUMED |
| 출고일 | `출고일` | 이벤트 일자 | ASSUMED |
| 상품·수량 | `상품코드`, `수량` | — | ASSUMED |
| 금액·세금 | `공급가액`, `세액` | `amountBasis=SUPPLY`. 세액 0 행(면세·수출)은 1.1 나누기 금지 | ASSUMED |
| 반품 | `반품여부`, `반품일` | 반품일에 원출고 행에 연결된 음수 이벤트. 기록 방식(별도 행/음수/원행 수정) 미확인 | ASSUMED |
| 수정 감지 | 행 해시 | 최신 파일에 없는 키 = 삭제 후보 | ASSUMED |
| 갱신 주기 | — | 10시 전 전일분 확보 가능성 확인하지 못함 | UNVERIFIED |

## 4. 광고 → ad_daily_spend / ad_balances

| 표준 필드 | 메타 | 구글 | 네이버 | 쿠팡 | 틱톡 |
|---|---|---|---|---|---|
| 광고 계정 | `account_id` (SNIPPET) | `customer.id` (SNIPPET) | `X-Customer` customerId (SNIPPET) | 확인하지 못함 (UNVERIFIED) | `advertiser_id` (SNIPPET) |
| 날짜 | `date_start`(=`date_stop`, `time_increment=1`) (SNIPPET) | `segments.date` (SNIPPET) | `timeRange`+`timeIncrement=1` / StatReport `statDt` (SNIPPET) | — | `stat_time_day` (SNIPPET) |
| 시간대 | 계정 시간대(보존, KST 이동 금지) | `customer.time_zone` (SNIPPET) | KST | KST | `advertiser/info` timezone (ASSUMED) |
| 통화 | `account_currency` (SNIPPET) | `customer.currency_code` (SNIPPET) | KRW (CONFIRMED) | KRW | `advertiser/info` currency (ASSUMED) |
| 소진액 | `spend` 문자열 소수 (SNIPPET) | `metrics.cost_micros` ÷ 1e6, BigInt 변환 (SNIPPET) | `salesAmt` (SNIPPET) | — | `spend` (SNIPPET) |
| 세금 기준 | UNKNOWN (ASSUMED) | UNKNOWN (ASSUMED) | UNKNOWN (ASSUMED) | — | UNKNOWN (ASSUMED) |
| 잔액 | 확인하지 못함 (UNVERIFIED) | 확인하지 못함 (UNVERIFIED) | `GET /billing/bizmoney` 응답 필드 원문 확인 (SNIPPET) | 확인하지 못함 (UNVERIFIED) | `advertiser/balance/get` 필드 원문 확인 (SNIPPET) |
| 원천 버전(대체 규칙) | 수집 실행 ID. (계정, 일자) 재수집은 대체 | 동일 | 동일 | — | 동일 |

## 5. 회계(위하고) → accounting_imports / accounting_lines

| 표준 필드 | 원천 | 규칙 | 근거 |
|---|---|---|---|
| 공식 읽기 경로·자격 | 존재 여부 확인하지 못함 | 더존 확인 | UNVERIFIED |
| 법인/회계기간 | 회사코드/기간 컬럼(가정) | — | ASSUMED |
| 계정/금액 | 계정코드/차·대 금액(가정) | — | ASSUMED |
| 전표/행 ID | 전표번호/행번호 | 제공 시 함께 수집. 요약만 제공되면 없음 | ASSUMED |
| 자료 형태 | 사용자 지정 MONTHLY/CUMULATIVE | 누적은 동일 기준 전월 누적이 있을 때만 차감. 없으면 전환 불가 목록(임의 산출 금지) | ASSUMED |
| 원천 최신성 | 월 단위 전표 정리 | 수집 시각과 자료 기준일 분리 표시 | CONFIRMED(사용자 확인) |

## 6. 환율 → fx_rates

| 표준 필드 | 수출입은행 | ECOS |
|---|---|---|
| 통화 | `cur_unit`(USD. JPY(100) 등 100 단위 통화 정규화 필요) (SNIPPET) | 항목 0000001 = 원/미국달러 (SNIPPET) |
| 기준일 | 요청 `searchdate` 보존 (SNIPPET) | `TIME` YYYYMMDD (SNIPPET) |
| 환율 종류 | `KOREAEXIM_DEAL_BAS_R`(`ttb`/`tts` 별도) (CONFIRMED 상수) | `ECOS_731Y001_0000001` (CONFIRMED 상수) |
| 값 | `deal_bas_r` 콤마 제거 후 십진수 (SNIPPET) | `DATA_VALUE`(필드명 원문 확인) (ASSUMED) |
| 휴일 | 빈 결과 → 이전 영업일 대체 + `appliedForDate` 표시. 없으면 오류(0 대체 금지) (SNIPPET) | 동일 규칙 적용 예정 |
| 출처·수집일 | 상수·실행 시각 | 동일 |

## 7. 계획서 요구와 원천 제공의 차이(매핑표 차원에서 확인된 것)

| 계획서 요구 | 원천 상황 | 처리(설계 담당자 확정 대상) |
|---|---|---|
| 은행 거래 ID | 오픈뱅킹 발췌 필드에 거래별 ID 미발견(원문 미확인) | 부재가 확인되면 대체키 + 거래후잔액 순서로 구분(§5 "ID 가 없으면 파일/원천 행 식별" 규칙 적용) |
| 기준일(전일) 잔액 | 오픈뱅킹 발췌상 `balance_amt` 는 조회 시점 잔액. 일자 지정 조회 여부 미확인 | 확인 전 안: 전일 마지막 거래후잔액으로 유도하고 조회 시점 잔액과 함께 대조 |
| 결제 완료 일시 | 사방넷·카페24 모두 필드 미확인 | 실제 응답 확보 후 확정. 주문일만 있으면 차이 명시 |
| 부분취소·분할환불 이벤트 | 사방넷·카페24 취소 확정일 필드 미확인 | 확인 전 임의 날짜 대체 금지(UNKNOWN) |
| 광고 세금 기준 | 5개 플랫폼 모두 미확인 | UNKNOWN 으로 저장, 확정 표시 금지 |
| 광고 잔액 | 네이버·틱톡은 조회 경로 존재를 발췌로 확인, 메타·구글·쿠팡은 확인하지 못함 | 미확인 잔액은 누락 표시(§6) |
| 위하고 전표·행 ID | 읽기 경로 존재 여부를 확인하지 못함 | 제공 시 수집 |
