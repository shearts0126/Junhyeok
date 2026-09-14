# FIN-01 실행결과

- 실행 환경: 원격 컨테이너(Node v22.22.2, pnpm 10.33.0), 저장소 `shearts0126/Junhyeok` 브랜치 `claude/festive-dijkstra-i5llac`
- 실행일: 2026-09-14 (UTC 기준 시각 아래 표기, KST = UTC+9)
- **요약: 실제 원천 호출은 한 건도 성공하지 못했다.** 자격정보가 제공되지 않았고(전 출처), 실행 환경의 egress 정책이 외부 호스트를 모두 차단했다. 아래 건수·금액 대조는 전부 **가상 데이터(synthetic)** 기반이며 실제 연동 성공을 뜻하지 않는다.

## 1. 실행 목록

| # | 모드 | 시작(UTC) | 종료(UTC) | 대상 기간(가상) | 결과 파일 | 결과 |
|---|---|---|---|---|---|---|
| R1 | 가상 샘플 검증 | 2026-09-14T10:49:59.126Z | 2026-09-14T10:49:59.159Z | 2026-09-12 ~ 2026-09-13 | `results/fixture-run.json` | 49건 통과 / 실패 0 (synthetic=true) |
| R2 | 실제 호출(네트워크 탐침) `--live fx-exim --date 2026-09-12` | 2026-09-14T10:45:53.090Z | 2026-09-14T10:45:53.774Z | 2026-09-12 | `results/live-run-network-probe.json` | `BLOCKED_NETWORK`: HTTP 403, `x-deny-reason: host_not_allowed`(프록시 응답, 원천 응답 아님). 인증키는 자리표시자 문자열이며 프록시에서 차단되어 원천에 도달하지 않음 |
| R3 | 실제 호출 `--live all --date 2026-09-12` | 2026-09-14T10:45:54.616Z | 2026-09-14T10:45:54.616Z | 2026-09-12 | `results/live-run.json` | 7개 소스 전부 `BLOCKED_NO_CREDENTIALS` |
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
| 10:3x | curl 탐침: developers.facebook.com, developers.google.com, naver.github.io, developers.coupang.com, business-api.tiktok.com, developers.cafe24.com, sabangnet.co.kr, developers.wehago.com, wehago.com, developers.kftc.or.kr, developer.codef.io, webcash.co.kr, hyphen.im, koreaexim.go.kr, ecos.bok.or.kr, smbs.biz, oapi.koreaexim.go.kr, open.er-api.com, api.frankfurter.app, data.go.kr → 전부 프록시 403 | 공식 문서는 검색 결과 발췌로만 확인. 연동검증표에 근거 수준 표기 |
| 10:3x | WebFetch 도구도 동일 도메인에서 `EGRESS_BLOCKED` | 동일 |
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

`pnpm typecheck`, `pnpm exec eslint fin`, `pnpm format:check` 통과(2026-09-14). 기존 `src/`·`prisma/`·테스트 미변경.
