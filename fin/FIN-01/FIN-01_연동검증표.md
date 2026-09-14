# FIN-01 연동검증표

- 기준: `FIN_개발계획_v1.0.md` §4 수집 경로와 FIN-01 검증 명세
- 확인일: 2026-09-14 (모든 URL 동일)
- 검증 환경 제약(전 출처 공통): 본 실행 환경의 네트워크 egress 정책은 **시도한 공식 문서·API 호스트 29개 전부**(curl 20개, WebFetch 9개 도메인, 목록은 `FIN-01_실행결과.md` §5)를 차단했다(프록시 403, `x-deny-reason: host_not_allowed`). 시도하지 않은 호스트에 대해서는 판단하지 않는다. GitHub·npm 레지스트리 등 저장소 운영 호스트는 허용되어 있었다(의존성 설치·푸시 성공). 공식 문서 원문을 직접 열람하지 못했고 실제 API 호출도 성공하지 못했다. 아래 "공식 근거" 는 **공식 도메인 문서의 검색 결과 발췌**로 확인한 것이며 원문 열람으로 재확인이 필요하다. 어떤 출처도 자격정보(토큰·키·계정)가 제공되지 않았다. 따라서 **실제 수집 검증 완료 상태인 출처는 없다.**
- 표현 규칙: "확인하지 못함(미확인)" 과 "지원하지 않음(지원 불가 확인)" 을 구분한다. 이 문서에서 "없음"·"미지원" 으로 단정한 항목은 공식 근거를 함께 적은 경우뿐이다.
- 상태 정의: `실제 수집 검증 완료` / `공식 문서 확인` / `접근 대기` / `미확인` / `지원 불가 확인`. 문서·권한이 없다는 이유로 지원 불가로 판정하지 않았다. 근거 수준 표기: (발췌) = 공식 문서 검색 발췌, 원문 미열람.

## 1. 요약

| 출처 | 검증 상태 | 한 줄 결론 |
|---|---|---|
| 은행 A: 금융결제원 오픈뱅킹 | 공식 문서 확인(발췌) → 접근 대기 | 법인 이용 2025-01-02 확대(금융위 보도 발췌). 이용기관 등록·보안점검(약 4주)·은행별 조회대상 계좌등록 필요(발췌). 발췌된 응답 필드 목록에 거래별 ID 미발견(원문 미확인). USD 계좌 지원 여부 확인하지 못함 |
| 은행 B: 웹케시 브랜치(ERP연계 API) | 공식 안내 확인(발췌) → 미확인 | 전 은행 원화 + 17개 은행 외화계좌 잔액·거래내역·고시환율 지원 표기. 필드·요금·인증 갱신 미확인(영업 문의 필요) |
| 은행 C: CODEF(기업 계좌 API) | 공식 개발가이드 존재 확인(발췌) → 미확인 | 기업 수시입출·외화 거래내역 API 존재. 인증서 등록(스크래핑) 방식. 요금·필드 미확인 |
| 소비자 매출: 사방넷 API | 접근 대기 | API 서비스는 유료 부가서비스, 연동키는 마이페이지에서 확인. 주문 필드·상태코드·결제완료 일시 제공 여부 미확인. 회사 계정의 API 서비스 가입 여부 미확인 |
| 자사몰: 카페24 Admin API | 공식 문서 확인(발췌) → 접근 대기 | OAuth2(액세스 2시간/리프레시 2주), Leaky Bucket 제한, 버전 헤더 확인. 주문 필드 원문 미확인. 실제 카페24 사용 여부 미확인 |
| 납품 매출: 공유 위치 엑셀 | 접근 대기 | 샘플·공유 위치·갱신 주기·반품/수정 기록 방식 미제공 |
| 광고: 메타 | 공식 문서 확인(발췌) → 접근 대기 | Insights `spend`/`date_start`/`account_currency`, 일별 `time_increment=1`. 28일 소급 갱신, 37개월 조회(제3자 요약). System User 토큰·접근 등급 필요. 선불 잔액 조회 미확인 |
| 광고: 구글 | 공식 문서 확인(발췌, 개발자 토큰 페이지는 설계 담당자 원문 확인) → 접근 대기 | GAQL `metrics.cost_micros`/`segments.date`/`customer.currency_code`/`customer.time_zone`. 2026-09-09 개발자 토큰 종료, 접근 수준은 Google Cloud 프로젝트 기준(기존 헤더는 선택적·무시, 향후 주요 버전에서 거부 예정). 신규 리프레시 토큰 발급 시 패스키 필요(2026-08-05, 기존 토큰·서비스 계정 흐름 제외, 발췌). 검증 코드는 개발자 토큰을 요구하지 않음. 잔액 조회 경로 확인하지 못함 |
| 광고: 네이버 검색광고 | 공식 문서 확인(발췌) → 접근 대기 | `/stats` `salesAmt`, StatReport(최대 92일), `/billing/bizmoney` 잔액 조회 존재. HMAC 서명 인증. VAT 관계 미확인 |
| 광고: 쿠팡 | 미확인 | 판매자용 광고 소진액 공식 API 존재를 확인하지 못함. 광고센터 리포트(엑셀) 확인. 전일 데이터 익일 12:30 이후 안내(CPS 리포트 기준) |
| 광고: 틱톡 | 공식 문서 확인(발췌) → 접근 대기 | `report/integrated/get`(일별 분해 1회 30일), `advertiser/balance/get` 존재. 토큰 만료 정책 미확인 |
| 회계: 위하고 | 미확인 | 공식 개발자 포털·읽기 API 문서 존재를 확인하지 못함. 현재 계약 상품의 제공 범위는 더존 확인 필요. 전표는 월 단위 정리(사용자 확인) |
| 환율: 한국수출입은행 Open API | 공식 문서 확인(발췌) → 접근 대기 | `deal_bas_r`(매매기준율)·`ttb`·`tts`, 영업일 11시경 갱신, 일 1,000회, 인증키 즉시 발급(무료), 신규 도메인 `oapi.koreaexim.go.kr` |
| 환율: 한국은행 ECOS | 공식 문서 확인(발췌) → 접근 대기 | 통계표 731Y001 항목 0000001(원/미국달러 매매기준율), 무료 인증키, 약 1,000회/일 |
| 환율: 서울외국환중개 | 공식 사이트 확인(발췌) → 미확인 | 매매기준율(시장평균환율) 영업일 08:30경 공표. API 제공·이용 조건 미확인 |

## 2. 출처별 상세

### 2.1 은행 — 후보 비교(계획서 §4: 최소 2개 공식 후보를 같은 기준으로)

| 기준 | A. 금융결제원 오픈뱅킹 | B. 웹케시 브랜치 ERP연계 API | C. CODEF 기업 계좌 API |
|---|---|---|---|
| 검증 상태 | 공식 문서 확인(발췌) → 접근 대기 | 공식 안내 확인(발췌) → 미확인 | 공식 개발가이드 확인(발췌) → 미확인 |
| 공식 근거 URL(확인일 2026-09-14) | https://developers.kftc.or.kr/dev/openapi/open-banking/transaction · https://developers.kftc.or.kr/dev/openapi/open-banking/balance · https://openapi.kftc.or.kr/ · 금융위 보도자료(법인 확대) https://fsc.go.kr/no010101/83750 | https://www.xbranch.co.kr/branch/html/branch4_2000.html (ERP연계) · https://xbranch.co.kr/webcash_new/1202.html (자금관리) | https://developer.codef.io/products/bank/common/b/transaction (기업 수시입출) · https://developer.codef.io/products/bank/common/b/fastAccount · https://developer.codef.io/ |
| 국민·기업·신한·우리·하나 지원 | 참가기관 목록 페이지(https://openapi.kftc.or.kr/service/openBanking) 원문 미열람 → 5개 은행 개별 확인 못 함(미확인) | "전 은행 원화 계좌" 표기(발췌). 은행별 개별 확인 미실시 | "20개 은행" 지원 표기(발췌). 5개 은행 개별 확인 미실시 |
| 법인 계좌 | 2025-01-02부터 법인 이용자 확대(금융위·금결원 발표 발췌). 각 은행에서 "조회 대상 계좌등록" 사전 신청 필요 | 법인 CMS 상품(중견·대기업용) | 기업(법인·개인사업자) API 별도 제공 |
| USD(외화) 계좌 | **확인하지 못함**(발췌 범위에서 외화계좌 조회 언급을 찾지 못함. 미지원 단정 아님) | 17개 은행 외화계좌 잔액·거래내역·고시환율 지원 표기(발췌, 필드·조건 미확인) | 기업 외화 거래내역 API 페이지 존재(발췌, 필드·조건 미확인) |
| 거래내역 | 거래내역조회 API, 페이지당 최대 25건(발췌), `next_page_yn`/`befor_inquiry_trace_info` 페이징 | 지원 표기. 필드 미확인 | 지원. 필드 미확인 |
| 전일 잔액 | 발췌상 거래내역 응답의 `balance_amt` 는 조회 시점 잔액. 일자 지정 잔액 조회 파라미터의 존재 여부는 원문 미확인 → 확인 전까지 전일 마지막 `after_balance_amt` 로 유도하는 안을 가정 | 미확인 | 미확인 |
| 거래 고유 ID | 발췌된 `res_list` 필드 목록에 거래별 ID 미발견(`bank_tran_id`·`api_tran_id` 는 호출 단위로 발췌). 원문 미확인이므로 "없음" 단정 아님. 없을 경우 대체키 안(§필드매핑표 1.1) | 미확인 | 미확인 |
| 과거 조회 기간 | 미확인 | 미확인 | 미확인 |
| 인증·갱신 | OAuth 2.0 Access Token + 핀테크이용번호. 이용기관 등록(사업자, 사업계획서, HTTPS 도메인, 개인정보처리방침) + 보안점검 약 4주(발췌) | 서비스 계약 + 은행별 서비스 신청. 인증서 갱신 요건 미확인 | 인증서(공동인증서) 등록 → connectedId 방식(스크래핑). 인증서 갱신 시 재등록 필요할 가능성(미확인) |
| 확인된 비용 | 언론 보도 기준 잔액조회 10원·거래내역조회 30원/건, 소형사 감면(공식 요율표 미열람) | 미확인 | "쓴 만큼 과금", 샌드박스 무료(발췌). 단가 미확인 |
| 미확인 비용 | 이용기관 등록·보안점검 비용, 법인 요율 | 월 이용료, 초기 구축비 | 정식 계약 단가·최소 약정 |
| 실제 검증 범위 | 가상 샘플로 페이징·대체키·재수집·잔액 대조 검증(`BANK-KFTC-01~08`). 실제 호출 없음 | 자리표시자 컬럼 설정 기반 매핑만 검증(`BANK-AGG-01~03`) | 동일(B와 같은 설정 기반 매핑) |
| 다음 조치 | ① 이용기관 등록 여부·비용·기간을 금결원에 문의 ② 외화계좌 지원 여부 확인 ③ 테스트베드(https://developers.openbanking.or.kr/) 자격으로 실제 응답 1일치 확보 | ① 웹케시 영업 문의: 5개 은행·USD·API 명세·요금·인증 갱신 ② 샘플 응답 확보 | ① CODEF 샌드박스 계정으로 응답 구조 확보 ② 정식 요금·인증서 운영 정책 확인 |

비교 근거 요약(설계 담당자 선택용): A 는 공식 표준이며 법인 확대가 발췌로 확인됐지만 USD 지원·거래별 ID·일자 기준 잔액을 확인하지 못했고 등록 절차(약 4주, 발췌)가 있다. B·C 는 외화 지원이 표기되어 있으나 필드·요금·인증 갱신을 확인하지 못했다. 신청 자격·비용·조회 가능 범위는 세 후보 모두 회사 계정 기준으로 확인된 바 없다. 세 후보 모두 실제 응답을 확보하지 못했으므로 기본 계약을 지정하지 않으며, 세 곳 모두에 문의하는 것을 선행조건으로 두지 않는다(선택에 필요한 미확인 항목만 `FIN-01_검토요청.md` §4 에 남김).

### 2.2 소비자 매출 — 사방넷 API

| 항목 | 내용 |
|---|---|
| 검증 상태 | 접근 대기 |
| 수집 경로·공식 근거 | 사방넷 API 서비스(유료 부가서비스). https://www.sabangnet.co.kr/service-intro/api-service (발췌) · 연동 몰 목록 https://www.sabangnet.co.kr/html/function_intro_mall_list.html (차단, 미열람) · 올리브영 외부셀러 연동 https://oliveyoung.tech/2023-12-15/seller-service-1/ (발췌) |
| 현재 상품·권한 이용 가능 여부 | **미확인**. 회사가 사방넷 API 서비스에 가입했는지, 연동키 발급 상태인지 확인 필요(마이페이지 > 서비스 관리 > 연동키/API 인증키 관리) |
| 확보 필드 | 없음(명세 미확인) |
| 부족 필드(계획서 §4 필수) | 판매자/채널/주문/항목 ID, 결제 완료 일시·금액, 할인·세금·취소/환불, 상품 코드 — 전부 실제 필드명 미확인. 특히 **결제 완료 일시** 제공 여부와 **구매확정과의 구분**이 핵심 |
| 조회 기간·갱신 지연·호출 제한 | 미확인 |
| 인증·갱신 | 연동키(API 인증키). 만료·갱신 정책 미확인 |
| 확인된 비용 | API 서비스가 유료라는 사실만 확인. 금액 미확인 |
| 채널 포괄 범위 | 발췌 기준 연동 몰: 스마트스토어, 쿠팡, 무신사, 카카오, 11번가, 롯데온 등. 올리브영 온라인은 올리브영 외부셀러 서비스가 사방넷과 연동됨(올리브영 기술블로그). **다이소, 자사몰(카페24) 연동 여부 미확인.** 회사 전체 채널(약 40개) 목록 미확보 → 포괄 범위 판정 보류 |
| 실제 검증 범위 | 자리표시자 필드로 결제완료/구매확정 구분, 부분취소 연결, 재수집 무중복, 직접 API 중복 탐지 검증(`SALES-SBN-01~06`). 실제 호출 없음 |
| 다음 조치 | ① API 서비스 가입 여부·요금 확인 ② API 명세서(주문 조회 필드·상태코드·조회 파라미터) 확보 ③ 회사 전체 채널 목록과 사방넷 연동 채널 대조 ④ 최소 1일치 실제 응답 확보 |

### 2.3 자사몰 — 카페24 Admin API

| 항목 | 내용 |
|---|---|
| 검증 상태 | 공식 문서 확인(발췌) → 접근 대기 |
| 수집 경로·공식 근거 | Admin API `GET /api/v2/admin/orders`. https://developers.cafe24.com/docs/api/admin/ (차단, 미열람) · 토큰 재발급 https://developers.cafe24.com/en/app/front/app/develop/oauth/retoken (발췌) · Admin API 사용 https://developers.cafe24.com/en/app/front/app/develop/api/adminapi (발췌) |
| 현재 상품·권한 이용 가능 여부 | **미확인**. 자사몰이 카페24인지, 앱(개발자센터) 설치·권한(주문 읽기 scope) 상태 미확인 |
| 확보 필드(발췌) | 인증·버전·날짜 형식: OAuth2, 액세스 토큰 2시간, 리프레시 토큰 2주(갱신 시 둘 다 재발급), `X-Cafe24-Api-Version`, 날짜 ISO 8601, HTTPS 전용, `x-ratelimit-remaining` |
| 부족 필드 | 주문·품목 식별자, 결제일, 취소·반품 상태·확정일, 공급가/할인/배송비 구분 — 원문 미열람(자리표시자) |
| 조회 기간·갱신 지연·호출 제한 | Leaky Bucket(버킷 크기 원문 확인 필요). 과거 조회 기간 미확인 |
| 인증·갱신 | 리프레시 토큰 2주 → 무인 수집 시 2주 내 자동 갱신 스케줄 필수. 실패 시 재인가 |
| 비용 | 미확인(앱 이용 조건) |
| 중복 방지 | 사방넷이 자사몰 주문을 포괄하면 카페24 직접 연동 제외(계획서 §4). 가상 검증에서 동일 주문 중복 탐지 확인(`SALES-C24-04`) |
| 실제 검증 범위 | `SALES-C24-01~05`(가상) |
| 다음 조치 | ① 자사몰 플랫폼 확인 ② 사방넷 포괄 여부 확정 후 필요 시 개발자센터 앱 생성·주문 읽기 권한·토큰 ③ 주문 리소스 원문 확인 |

### 2.4 납품 매출 — 공유 위치 엑셀

| 항목 | 내용 |
|---|---|
| 검증 상태 | 접근 대기 |
| 수집 경로 | 승인된 공유 폴더의 엑셀 자동 읽기(계획서 §4). 공식 문서 없음 |
| 이용 가능 여부 | 샘플 파일·공유 위치 미제공 |
| 확보/부족 필드 | 실제 헤더 미확인. 계획서 필수 필드(법인/거래처/출고번호·행, 출고일, 상품·수량·금액·세금, 반품)를 컬럼으로 가정한 검증만 수행 |
| 갱신 주기 | 미확인. **10시 전 전일 출고분 확보 가능 여부**는 사용자 확인 필요 |
| 인증 | 공유 위치 종류(구글 드라이브/원드라이브/SMB 등)에 따라 다름. 미확인 |
| 비용 | 없음(내부 파일) |
| 실제 검증 범위 | `DLV-01~08`(가상): 필수 컬럼, 고유키, 금액 대조, 반품 연결, 행 해시 수정 감지, 주문 시스템 중복 탐지, 면세 행 |
| 다음 조치 | ① 비식별 샘플 1개월분과 공유 위치 ② 출고번호 유무, 반품·수정·삭제 기록 방식 ③ 파일 갱신 시각 |

### 2.5 광고

| 항목 | 메타 | 구글 | 네이버 검색광고 | 쿠팡 | 틱톡 |
|---|---|---|---|---|---|
| 검증 상태 | 공식 문서 확인(발췌) → 접근 대기 | 공식 문서 확인(발췌) → 접근 대기 | 공식 문서 확인(발췌) → 접근 대기 | 미확인 | 공식 문서 확인(발췌) → 접근 대기 |
| 공식 근거 | https://developers.facebook.com/docs/marketing-api/insights/ · https://developers.facebook.com/docs/marketing-api/insights/best-practices/ · https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/ | https://developers.google.com/google-ads/api/docs/api-policy/developer-token (설계 담당자 원문 확인) · https://developers.google.com/google-ads/api/docs/api-policy/access-levels (발췌) · https://developers.google.com/google-ads/api/docs/concepts/no-developer-token (발췌) · https://developers.google.com/google-ads/api/docs/oauth/user-authentication (설계 담당자 제시) · https://developers.google.com/google-ads/api/docs/oauth/single-user-authentication (발췌) · https://developers.google.com/google-ads/api/docs/oauth/security-requirements (발췌) · https://ads-developers.googleblog.com/2026/07/passkey-authentication-requirement-for.html (발췌) | https://naver.github.io/searchad-apidoc/ (차단) · https://github.com/naver/searchad-apidoc (발췌) · StatReport 공지 http://naver.github.io/searchad-apidoc/notice/2021/03/09/notice1/ | https://ads.coupang.com/AaaAna.html (광고분석가이드, 발췌) · https://developers.coupang.com/ko/api (판매자 Open API, 발췌) | https://business-api.tiktok.com/portal/docs (차단) · https://github.com/tiktok/tiktok-business-api-sdk (발췌) |
| 계정별 일별 소진액 | `act_{id}/insights` `fields=spend,account_currency,date_start,date_stop` `time_increment=1` `level=account` | GAQL `SELECT customer.id, customer.currency_code, customer.time_zone, segments.date, metrics.cost_micros FROM customer WHERE segments.date BETWEEN …` | `/stats` `fields=["salesAmt",…]` `timeRange` + `timeIncrement=1` 또는 StatReport(대용량, 최대 92일) | **공식 API 미확인.** 광고센터 캠페인/일별 리포트·광고비 정산 리포트 엑셀 다운로드 확인 | `report/integrated/get` `data_level=AUCTION_ADVERTISER` `dimensions=[advertiser_id,stat_time_day]` `metrics=[spend]` |
| 통화·시간대 | `account_currency`, 계정 시간대 일자(KST 이동 금지) | `customer.currency_code`, `customer.time_zone` | KRW, KST | KRW, KST | `advertiser/info` 통화·시간대(필드명 미확인) |
| 세금 기준 | 미확인(UNKNOWN 표시) | 미확인 | 미확인(salesAmt 와 비즈머니 차감액의 VAT 관계) | 미확인 | 미확인 |
| 지연·과거 수정 | 기여 창 마감으로 최대 28일 소급 갱신(제3자 요약) → 7일 재조회 + 주간 28일 재점검 | 소급 정정 있음(무효 클릭 등, 미확인) → 7일 재조회 | 미확인 | 전일 데이터 익일 12:30 이후(CPS 리포트 안내, 판매자 광고 동일 여부 미확인) → **10시 전 확정 불가 가능성** | 미확인 |
| 잔액 조회 | 미확인(선불 잔액 API 확인 못 함) | 미확인 | `/billing/bizmoney`(get, get(period), histories) 존재(GitHub 이슈로 확인) | 미확인 | `advertiser/balance/get` 존재(SDK 문서) |
| 조회 기간·호출 제한 | 집계 37개월, 일부 breakdown 13개월(제3자 요약). 계정 단위 rate limit, `x-fb-ads-insights-throttle` | 미확인 | StatReport 92일/회 | 미확인 | 일별 분해 1회 30일(제3자 요약) |
| 인증·갱신 | System User 토큰(장기). Marketing API 접근 등급 + 비즈니스 인증 필요 | ① API 접근 수준: Google Cloud 프로젝트 단위(2026-09-09 개발자 토큰 종료. 기존 `developer-token` 헤더는 선택적·무시, 향후 주요 버전에서 거부 예정 — 공식 developer-token 페이지, 설계 담당자 원문 확인) ② 광고 계정 권한: OAuth 로 동의한 Google 계정이 대상 고객 ID(또는 관리자 계정 `login-customer-id`)에 접근 권한을 가져야 함(별개 조건) ③ 인증 방식: 사용자 OAuth(초기 1회 대화형 동의 → 리프레시 토큰, 이후 무인 갱신) 기본. 서비스 계정은 Workspace 도메인 전체 위임 조건에서만(발췌) ④ 패스키: 2026-08-05부터 **신규** 리프레시 토큰 발급 시 필요, 기존 토큰·서비스 계정 흐름 제외(공식 블로그 발췌) | 액세스라이선스·비밀키·CUSTOMER_ID, `X-Timestamp`/`X-API-KEY`/`X-Customer`/`X-Signature`(HMAC-SHA256). 광고플랫폼 > 도구 > API 사용관리 | — | Access Token(장기). 만료 정책 미확인 |
| 비용 | API 무료, 광고비 별도 | API 무료 | API 무료 | — | API 무료 |
| 실제 검증 범위 | `ADS-META-01~02`(가상): 일별 대체, 시간대 보존 | `ADS-GOOG-01`(가상): micros 변환 | `ADS-NAVER-01`(가상): 소진·잔액 분리 | `ADS-CPNG-01`: 미확인 표시 | `ADS-TT-01~02`(가상): 30일 분할, 필드 보존 |
| 다음 조치 | 광고 계정 목록·법인 매핑, 앱·System User 토큰 준비 | Google Cloud 프로젝트에서 API 접근 수준 신청(Overview 페이지), 광고 계정 권한이 있는 계정으로 초기 OAuth 동의(패스키) → 리프레시 토큰 보관, 고객 ID 목록 | API 라이선스 발급, CUSTOMER_ID 목록 | 쿠팡 광고 담당자에게 판매자/대행사 API 제공 여부 문의. 없으면 엑셀 보조 경로로 확정 | 앱 생성·광고주 인가, 계정 목록 |

### 2.6 회계 — 위하고

| 항목 | 내용 |
|---|---|
| 검증 상태 | 미확인 |
| 공식 근거 | https://www.wehago.com/ (차단) · https://www.douzoneon.com/s1/down/wehago_leaflet.pdf (발췌: "Report 파일 또는 API 형태" 언급) · 검색에서 developers.wehago.com 개발자 포털·Open API 문서 존재를 확인하지 못함 |
| 현재 계약·권한 조회 범위 | 미확인. 계정·거래처·전표·원장·손익 자료 중 무엇을 어떤 형태(API/파일 내보내기)로 읽을 수 있는지 더존 확인 필요 |
| 원천 최신성 | 사용자 확인: 전표는 월 단위 정리 → 자동 조회가 가능해도 자료 기준일은 전월 이하. 자동 조회 가능성과 원천 최신성을 분리해 표시(계획서 §1) |
| 실제 검증 범위 | `ACC-WHG-01~04`(가상): 누적→월간 전환, 전월 누적 없으면 전환 불가 목록 |
| 다음 조치 | ① 더존 담당자에게 현재 상품의 외부 읽기 연동(API/데이터 내보내기) 제공 범위·자격·비용 문의 ② 없으면 월 1회 엑셀 내보내기(사용자 부담)를 보조 경로로 명시 |

### 2.7 환율

| 항목 | 한국수출입은행 Open API | 한국은행 ECOS | 서울외국환중개 |
|---|---|---|---|
| 검증 상태 | 공식 문서 확인(발췌) → 접근 대기 | 공식 문서 확인(발췌) → 접근 대기 | 공식 사이트 확인(발췌) → 미확인 |
| 공식 근거 | https://www.koreaexim.go.kr/ir/HPHKIR020M01?apino=2&viewtype=C · 공공데이터포털 https://www.data.go.kr/data/3068846/openapi.do | https://ecos.bok.or.kr/api/ | http://www.smbs.biz/ExRate/StdExRate.jsp |
| 환율 종류 | 은행 고시 기준 매매기준율 `deal_bas_r`, 전신환 `ttb`/`tts` | 원/미국달러 매매기준율(731Y001/0000001) | 시장평균환율(매매기준율), USD·CNY 직접 산출 |
| 일별 USD | `data=AP01&searchdate=YYYYMMDD` | 주기 D | 영업일 08:30경 공표 |
| 휴일 처리 | 비영업일 조회 시 빈 결과(제3자 사례) → 이전 영업일 대체·적용일 표시(`FX-02`) | 비영업일 자료 없음(추정) | 비영업일 공표 없음 |
| 갱신 시각 | 영업일 11시경 | 미확인 | 08:30경 |
| 호출 제한·인증 | 일 1,000회, 인증키 즉시 발급, 2년 미사용 파기, 신규 도메인 `oapi.koreaexim.go.kr`(구 도메인 병행 종료 2026-04-30) | 무료 인증키, 약 1,000회/일 | 미확인(웹 페이지) |
| 이용 조건·비용 | 무료. 이용약관 원문 미열람 | 무료 | 미확인 |
| 실제 검증 범위 | `FX-01~04`(가상). 실제 호출은 프록시 차단(`live-run-network-probe.json`) | 없음 | 없음 |
| 다음 조치 | 인증키 발급(무료) 후 1주일치 실제 응답 확보 | 인증키 발급 후 응답 확보 | API 제공 여부 문의 |

환율 종류 차이(설계 결정 입력): 수출입은행 값은 은행 고시 성격, 서울외국환중개는 시장평균환율이며 ECOS 도 매매기준율 계열이다. 어느 종류를 보고일 환산에 쓸지 설계 담당자가 고정한다(계획서 §6).

## 3. 계획서 §10 재조회 정책 입력(원천별)

| 출처 | 변경 조회 기능 | 제안 실행 방식(설계 담당자 확정 대상) |
|---|---|---|
| 오픈뱅킹 | 없음(기간 조회만) | 최근 7일 일별 재조회, 잔액 대조로 누락 탐지 |
| 사방넷/카페24 | 수정일 기준 파라미터 유무 미확인 | 확인 전까지 최근 7일 전체 재조회 + 주간 90일 미종결 주문 재조회 |
| 메타/구글 | 소급 갱신 있음 | 최근 7일 일별 재조회 + 주간 28일 재점검(일자 대체) |
| 네이버/틱톡 | 미확인 | 최근 7일 재조회 |
| 납품 엑셀 | 파일 전체 재읽기 | 행 해시 비교로 수정·삭제 감지 |
| 환율 | 없음 | 당일 11시 이후 1회 + 08:30 실패 시 재시도 |
