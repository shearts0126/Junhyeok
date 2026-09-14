# FIN-01 실행결과

- 실행 환경: 원격 컨테이너(Node v22.22.2, pnpm 10.33.0), 저장소 `shearts0126/Junhyeok` 브랜치 `claude/festive-dijkstra-i5llac`
- 실행일: 2026-09-14 (UTC 기준 시각 아래 표기, KST = UTC+9)
- **요약: 실제 원천 호출은 한 건도 성공하지 못했다.** 자격정보가 제공되지 않았고(전 출처), 실행 환경의 egress 정책이 **시도한 공식 문서·API 호스트 29개 전부**를 차단했다(§5 목록. 시도하지 않은 호스트는 판단하지 않음. GitHub·npm 레지스트리는 허용되어 의존성 설치·푸시는 성공). 아래 건수·금액 대조는 전부 **가상 데이터(synthetic)** 기반이며 실제 연동 성공을 뜻하지 않는다. `--live` 코드는 요청 구성·전송까지만 구현했고 응답 파싱·정규화·대조는 미구현이다(§8).

## 1. 실행 목록

| # | 모드 | 시작(UTC) | 종료(UTC) | 대상 기간(가상) | 결과 파일 | 결과 |
|---|---|---|---|---|---|---|
| R1 | 가상 샘플 검증 | 2026-09-14T10:49:59.126Z | 2026-09-14T10:49:59.159Z | 2026-09-12 ~ 2026-09-13 | `results/fixture-run.json` | 49건 통과 / 실패 0 (synthetic=true) |
| R2 | 실제 호출(네트워크 탐침) `--live fx-exim --date 2026-09-12` | 2026-09-14T10:45:53.090Z | 2026-09-14T10:45:53.774Z | 2026-09-12 | `results/live-run-network-probe.json` | `BLOCKED_NETWORK`: HTTP 403, `x-deny-reason: host_not_allowed`(프록시 응답, 원천 응답 아님). 인증키는 자리표시자 문자열이며 프록시에서 차단되어 원천에 도달하지 않음. 구현 수준 `REQUEST_BUILT_SPEC_SNIPPET`, 파싱 미구현 |
| R3 | 실제 호출 `--live all --date 2026-09-12` | 2026-09-14T10:45:54.616Z(1차) / 보완 후 재실행은 `evidence/run-live.log` | — | 2026-09-12 | `results/live-run.json` | 7개 소스 전부 `BLOCKED_NO_CREDENTIALS`. 전 소스 파싱 미구현(조회 구현 미완료) |
| R0 | 환경 탐침(curl) | 2026-09-14 10:3x UTC | — | — | 본 문서 §5 | 20개 공식·공개 호스트 전부 `CONNECT tunnel failed, response 403` |

## 2. 계정 별칭(가상)

| 별칭 | 의미 |
|---|---|
| `DP-KB-001` | 딥포인트 KRW 계좌(오픈뱅킹 가상 핀테크이용번호 매핑) |
| `DV-SH-001`, `DV-SH-USD-001` | 디스트로바 KRW/USD 계좌(중계 경로 자리표시자) |
| `DP-SABANGNET-MAIN` | 딥포인트 사방넷 계정 |
| `DP-CAFE24-OWNMALL` | 딥포인트 자사몰(카페24) |
| `act_SYN000001`, `SYN-123-456-7890`, `SYN-NAVER-1`, `SYN-TT-1` | 메타/구글/네이버/틱톡 광고 계정 |

실제 계정·계좌·주문·구매자 정보는 어디에도 포함하지 않았다.

## 3. 건수·금액 대조(R1, 가상 데이터)

| 검증 ID | 출처 | 원본 | 정규화 | 일치 |
|---|---|---|---|---|
| BANK-KFTC-02 | 오픈뱅킹 거래내역(2페이지, 25건 이하) | 5건, 순 +430,000 | 5건, 순 +430,000 | 예 |
| BANK-KFTC-05 | 기초 1,000,000 + 누적 입출금 | 1,430,000 | 원천 `after_balance_amt` 1,430,000 | 예 |
| BANK-AGG-01 | 중계 경로(자리표시자 컬럼) KRW+USD | 4건, 순 221,050.5 | 4건, 순 221,050.5 | 예(통화 혼합 합계는 대조용 표시일 뿐 환산·합산 금지) |
| SALES-SBN-01 | 사방넷 결제완료 행 | 4건, 179,000 | 4건, 179,000 | 예(구매확정 1행 제외) |
| SALES-SBN-02 | 부분취소 1건 연결 후 순매출 | — | 160,000 | 예 |
| SALES-C24-01 | 카페24 결제완료 품목 | 3건, 122,000 | 3건, 122,000 | 예(입금전 1주문 제외) |
| DLV-03 | 납품 출고 행 공급가액 | 3건, 8,300,000 | 3건, 8,300,000 | 예 |
| DLV-04 | 반품 1건 연결 후 순매출 | — | 8,100,000 | 예 |
| ADS-META-01 | 메타 3일 소진 재수집(1일 정정) | 1차 349.65 USD | 재수집 349.35 USD(최신 응답 합계와 동일, 누적 합산 안 됨) | 예 |
| ADS-GOOG-01 | 구글 `cost_micros` 2일 | 252,750 KRW | 252,750 KRW | 예 |
| ADS-NAVER-01 | 네이버 소진 2일 / 비즈머니 잔액 | 395,000 / 1,250,000 | 별도 레코드 | 예 |
| ACC-WHG-01 | 위하고 누적→월간(8월 401) | 누적 10,500,000 − 7,500,000 | 3,000,000 | 예 |
| FX-02 | 토요일(2026-09-12) 환율 | 빈 응답 | 2026-09-11 값 1335.10 적용, 적용일 표시 | 예 |

## 4. 재조회(재수집) 결과

| 검증 ID | 시나리오 | 결과 |
|---|---|---|
| BANK-KFTC-04 | 같은 응답 2회 수집 → 정정 응답 1회 | 1차 insert 5, 2차 unchanged 5, 3차 versioned 1, 저장 5(무중복) |
| BANK-KFTC-03 | 같은 날짜·시각·금액·적요의 정상 거래 2건 | 고유키 5/5, 합쳐지지 않음 |
| SALES-SBN-03, SALES-C24-03 | 같은 기간 재수집 | 2차 insert 0 |
| ADS-META-01 | 소급 정정 | (계정,일자) 대체, 합계가 최신 응답과 일치 |
| DLV-05 | 행 금액 수정 | 행 해시 변경으로 수정 감지 |
| X-01 | 정산 입금 + 매출 | 정산 입금은 은행 거래로만 보존, 매출 합산 금지 확인 |
| X-02 | 선불 광고 충전 100 / 소진 60 | 은행 −100, 잔액 +40, 비용 60 |
| X-03 | 사방넷·직접 API·납품 엑셀 중복 채널 | 담당 원천만 집계, 비담당·미지정 채널은 제외 목록 |

## 5. 오류·차단 기록

| 시각(UTC) | 내용 | 조치 |
|---|---|---|
| 10:3x | curl 탐침(20개 URL, 각 1회 GET, 최대 20초): developers.facebook.com, developers.google.com, naver.github.io, developers.coupang.com, business-api.tiktok.com, developers.cafe24.com, www.sabangnet.co.kr, developers.wehago.com, www.wehago.com, developers.kftc.or.kr, developer.codef.io, www.webcash.co.kr, hyphen.im, www.koreaexim.go.kr, ecos.bok.or.kr, www.smbs.biz, oapi.koreaexim.go.kr, open.er-api.com, api.frankfurter.app, www.data.go.kr → 전부 `CONNECT tunnel failed, response 403` | 공식 문서는 검색 결과 발췌로만 확인. 연동검증표에 근거 수준 표기 |
| 10:3x | WebFetch 도구(9개 도메인): developers.cafe24.com, www.sabangnet.co.kr, qxguide.oopy.io, naver.github.io, developers.facebook.com, developers.wehago.com, developers.kftc.or.kr, developer.codef.io, www.koreaexim.go.kr → 전부 `EGRESS_BLOCKED` | 동일. 시도 범위 밖 호스트는 미판단 |
| — | 허용 확인된 호스트: github.com(푸시 성공), registry.npmjs.org(설치 성공) | 저장소 운영용 허용 목록으로 추정. 허용 목록 변경 가능 여부는 미확인 |
| 10:4x | 1차 실행에서 `accounting-wehago` 예외(7월 누적 행의 전월 누적 없음 → 전체 중단) | 전월 누적 없는 행을 예외가 아닌 "전환 불가 목록" 으로 반환하도록 수정(임의 산출 금지 규칙 유지). 재실행 통과 |
| 10:45 | `--live fx-exim` HTTP 403 을 최초에 `FAILED` 로 분류 | `x-deny-reason` 헤더가 있으면 `BLOCKED_NETWORK` 로 분류하도록 수정(원천 응답과 프록시 차단 구분) |

## 6. 재현 방법

```bash
git checkout claude/festive-dijkstra-i5llac
pnpm install --frozen-lockfile
pnpm tsx fin/FIN-01/verify/run.ts                      # R1
pnpm tsx fin/FIN-01/verify/run.ts --live all --date 2026-09-12   # R3 (환경변수 없으면 전부 BLOCKED_NO_CREDENTIALS)
```

실제 자격이 준비된 환경에서는 `fin01.env.example` 의 변수명으로 값을 설정한 뒤 `--live <source>` 를 실행한다. 결과 JSON 은 상태·HTTP 코드·바이트 수·본문 해시·항목 수만 기록하며 본문·헤더·키를 저장하지 않는다. 실제 호출이 `OK` 가 되더라도 `verified` 는 대조 절차를 별도로 통과하기 전까지 `false` 다.

## 7. 저장소 품질 게이트

명령·종료 코드·요약 로그는 `evidence/` 에 있다(`run-fixtures.log`, `run-live.log`, `typecheck.log`, `lint.log`, `format-check.log`, `test-unit.log`, `versions.txt`). 기존 `src/`·`prisma/`·설정 파일 미변경(`evidence/commit-*-files.txt`).

## 8. `--live` 구현 수준(출처별)

`results/live-run.json` 의 `implementation` / `parsingImplemented` 와 동일하다. 2차 검토 후 수정: 결과·로그에 실제 URL 을 기록하지 않고 소스별 선언 템플릿(`endpoint`, ECOS 는 `{authkey}` 자리표시자)만 남기며, 외부 예외 메시지 대신 내부 오류 코드를 기록한다(`verify/live/http.ts`). 가짜 키로 재현해 `live-run.json` 에 키가 남지 않음을 확인했다(`evidence/live-secret-check.log`). **어떤 소스도 응답을 파싱·정규화·대조하지 않는다.** 자격정보를 설정해도 "조회 구현 미완료" 상태이며, 요청 형식 중 추정 부분은 실제 응답을 확인하기 전까지 확정 스키마가 아니다.

| 출처 | 공식 명세 확인 수준 | 실제 HTTP 요청 구현 | 인증 구현 | 응답 파싱 구현 | 실제 호출 결과 | 남은 작업 |
|---|---|---|---|---|---|---|
| 은행: 오픈뱅킹 | 발췌(응답 필드·페이징) | 있음. 경로 `/v2.0/account/transaction_list/fin_num` 과 파라미터명은 **추정** | Bearer 토큰 헤더만(토큰 발급·갱신 미구현) | 없음 | 자격 없음 → `BLOCKED_NO_CREDENTIALS` | 원문 명세 대조, 토큰 발급·갱신, 페이징 루프, `res_list` 파싱→`bank_transactions`, 대조. **조회 구현 미완료** |
| 은행: 웹케시/CODEF/하이픈 | 발췌(제품 안내) | 없음 | 없음 | 없음(설정 기반 매핑만) | 미시도 | 명세·샘플 확보 후 전부 |
| 사방넷 | 발췌(가입·연동키 안내) | 없음 | 없음 | 없음(자리표시자 매핑만) | 미시도 | 명세 확보 후 전부 |
| 카페24 | 발췌(OAuth·제한·헤더) | 있음. `/api/v2/admin/orders` 경로·파라미터 **추정**, 헤더는 발췌 | Bearer 토큰 헤더만(OAuth 발급·2주 갱신 미구현) | 없음 | 자격 없음 | 토큰 발급·갱신, 원문 명세 대조, 파싱→`sales_events`, 대조. **조회 구현 미완료** |
| 납품 엑셀 | 해당 없음 | 해당 없음(파일 읽기 미구현, 가상 행만) | 해당 없음 | 없음 | 미시도 | 샘플·위치 확보 후 파일 리더 |
| 메타 | 발췌(fields·time_increment) | 있음. `act_{id}/insights` 발췌, 그래프 API 버전 v21.0 **추정** | 토큰 쿼리 파라미터만 | 없음 | 자격 없음 | 원문 대조, 파싱→`ad_daily_spend`, 28일 재조회. **조회 구현 미완료** |
| 구글 | 발췌 + 개발자 토큰 페이지는 설계 담당자 원문 | 없음 | 없음(환경변수명만 예약, 개발자 토큰 불요) | 없음 | 미시도 | OAuth 리프레시→액세스, GAQL searchStream, 파싱 |
| 네이버 | 발췌(경로·서명 헤더명) | 있음. `/billing/bizmoney` 발췌, 서명 문자열 형식 **추정** | HMAC-SHA256 서명 구현(형식 추정) | 없음 | 자격 없음 | 서명 형식 원문 대조, `/stats` 요청, 파싱. **조회 구현 미완료** |
| 쿠팡 광고 | 발췌(광고센터 리포트) | 없음 | 없음 | 없음 | 미시도 | API 존재 확인 후 결정 |
| 틱톡 | 발췌(경로·차원) | 있음. 경로 발췌, 파라미터 값 **추정** | Access-Token 헤더만 | 없음 | 자격 없음 | 원문 대조, 30일 분할, 파싱. **조회 구현 미완료** |
| 위하고 | 확인하지 못함 | 없음 | 없음 | 없음(월간/누적 규칙만) | 미시도 | 읽기 경로 확인 후 전부 |
| 환율: 수출입은행 | 발췌(경로·파라미터·필드) | 있음. 경로·`data=AP01` 발췌 | authkey 쿼리 | 없음 | R2 `BLOCKED_NETWORK`(프록시 403), 자격 없음 | 파싱→`fx_rates`, 휴일 규칙 연결. **조회 구현 미완료** |
| 환율: ECOS | 발췌(통계표·항목) | 있음. `StatisticSearch` 경로 구조 **추정** | 키 경로 세그먼트 | 없음 | 자격 없음 | 원문 대조, 파싱. **조회 구현 미완료** |
| 환율: 서울외국환중개 | 발췌(웹 공표) | 없음 | 없음 | 없음 | 미시도 | API 제공 여부 확인 |
