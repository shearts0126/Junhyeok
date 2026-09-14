# FIN-01 보완검토결과

- 대상: 2차 검토 지시(FIN-01 READY_FOR_REVIEW 유지, 최종 승인 보류)에 대한 조치.
- 상태: **READY_FOR_REVIEW 유지.** FIN-02 구현 미착수. 실제 수집 검증 완료 출처는 여전히 0개.
- 보고 커밋: 1차 `db2e9cc`, 보완 커밋은 본 문서 제출 시 HEAD(대화 보고에 명시). 브랜치 `claude/festive-dijkstra-i5llac`.

## 1. 지시 항목별 조치와 증빙 위치

| # | 지시 | 조치 | 증빙 위치 |
|---|---|---|---|
| 1 | 검토용 제출물(ZIP·파일 목록·통계·diff·누적 diff·실행 로그·버전·재현) | `fin/FIN-01/` ZIP 을 대화 첨부로 제출. 저장소에는 `evidence/` 폴더로 텍스트 증빙 커밋 | ZIP: 대화 첨부 `FIN-01_review_<HEAD>.zip`(`.env` 실파일·`node_modules`·`.git` 미포함, 스크립트로 제외 확인). 파일 목록·통계·diff: `evidence/commit-db2e9cc-files.txt`, `evidence/commit-db2e9cc-stat.txt`, `evidence/commit-db2e9cc.diff`. 누적 diff(main→HEAD, evidence 폴더 자체 제외): ZIP 내 `evidence-post-commit/cumulative-main..HEAD.diff` 및 보완 커밋 diff(커밋이 자기 diff 를 담을 수 없어 ZIP 에만 포함). 실행 로그: `evidence/run-fixtures.log`, `run-live.log`, `typecheck.log`, `lint.log`, `format-check.log`, `test-unit.log`(각 명령·종료 코드 포함). 버전: `evidence/versions.txt`. 재현: `README.md` |
| 2 | 실제 연동 코드와 미구현 구분 | 출처별 구현 수준 표 작성. `--live` 결과에 `implementation`·`parsingImplemented` 필드 추가, 실행기 출력에 "조회 구현 미완료" 명시 | `FIN-01_실행결과.md` §8, `verify/live/http.ts`(`ImplementationLevel`), `verify/live/index.ts`(`LIVE_IMPLEMENTATION`), `results/live-run.json` |
| 3 | 근거 수준·표현 보완 | 근거 상태에 `UNVERIFIED`(확인하지 못함) 추가, `MISSING`(미제공 확인)과 분리. 이번 검증에서 `MISSING` 확정 항목 0건. 거래별 ID·기준일 잔액·USD·쿠팡 광고 API·위하고 API·신청 자격/비용/조회 범위 표현을 "확인하지 못함" 으로 정정. 네트워크 차단은 시도한 29개 호스트 목록으로 한정 | `verify/mapping.ts`, `FIN-01_연동검증표.md`(머리말·§2.1·§2.5), `FIN-01_필드매핑표.md`(1.1·4·5·7), `FIN-01_실행결과.md`(요약·§5) |
| 4 | 구글 Ads 인증 설명 | 코드는 개발자 토큰을 요구하지 않음(`--live` 구글 미구현, 환경변수 예시에 개발자 토큰 없음). 문서에 ①Cloud 프로젝트 접근 수준 ②광고 계정 권한 ③사용자 OAuth vs 서비스 계정 ④패스키 조건(신규 리프레시 토큰, 기존·서비스 계정 제외) ⑤초기 동의 vs 무인 갱신을 구분해 기술. 인증 방식 전환 없음 | `FIN-01_연동검증표.md` §1 구글 행·§2.5 인증 셀·공식 근거 셀, `fin01.env.example` 구글 블록. 근거: 설계 담당자 확인 원문 https://developers.google.com/google-ads/api/docs/api-policy/developer-token, 제시 문서 https://developers.google.com/google-ads/api/docs/oauth/user-authentication, 발췌 https://developers.google.com/google-ads/api/docs/api-policy/access-levels · https://developers.google.com/google-ads/api/docs/oauth/single-user-authentication · https://developers.google.com/google-ads/api/docs/oauth/security-requirements · https://ads-developers.googleblog.com/2026/07/passkey-authentication-requirement-for.html (확인일 2026-09-14) |
| 5 | 기존 SCM/WMS 영향 범위 | 본 문서 §3 | `evidence/commit-db2e9cc-files.txt`(전부 `fin/` 하위), `evidence/repo-impact.txt`(루트 설정·`src`·`prisma`·CI 대상 `git diff --stat` 결과 공란) |
| 6 | 사용자 준비사항 3단계 | 8개 항목을 ①지금 3개 ②경로 선택 후 3개 ③본격 연동 전 2개로 재정리. 은행 3사 문의·환율 키 2종 발급을 선행조건에서 제외. 허용 목록 변경 가능 여부는 미확인으로 두고 승인된 사내 실행 환경을 정식 대안으로 제시 | `FIN-01_검토요청.md` §4·§5 |
| 7 | 보완 결과 제출 | 본 문서 | — |

## 2. 실제 구현·미구현·실제 검증 상태

- 실제 검증(실제 응답을 받아 정규화·대조): **0개 출처.**
- 요청 구성·전송 구현(응답 파싱 없음): 오픈뱅킹(경로·파라미터 추정), 카페24(경로 추정, 헤더 발췌), 메타(필드 발췌, API 버전 추정), 네이버(경로 발췌, 서명 형식 추정), 틱톡(경로 발췌, 파라미터 추정), 수출입은행(경로·파라미터 발췌), ECOS(경로 추정). 전부 `parsingImplemented=false` → **조회 구현 미완료.**
- 자격정보 유무만 확인: 위 7개 소스가 환경변수 부재 시 `BLOCKED_NO_CREDENTIALS` 로 종료. 이 상태는 "자격정보 대기 + 조회 구현 미완료" 로 함께 표시한다.
- 네트워크 접근만 확인: 수출입은행 1회(`results/live-run-network-probe.json`, 프록시 403).
- 미구현: 웹케시/CODEF/하이픈, 사방넷, 납품 엑셀 파일 리더, 구글, 쿠팡 광고, 위하고, 서울외국환중개.
- 가상 샘플 검증(49건 통과)은 내부 규칙(무중복·버전·대체키·대조·시간대·휴일·중복 집계 방지) 시험이며 공급자 응답을 증명하지 않는다. 가상 스키마는 실제 API 계약이 아니다.

## 3. 기존 저장소 영향 범위

| 대상 | 변경 여부 | 비고 |
|---|---|---|
| 루트 `package.json`·`pnpm-lock.yaml` | 없음 | 의존성 추가 없음. 검증 코드는 기존 devDependency `tsx` 와 Node 내장 모듈만 사용 |
| `tsconfig.json`·`eslint.config.ts`·`vitest.config.ts`·`.prettierrc.json` | 없음 | 단, 기존 `tsconfig` 의 `include: **/*.ts` 와 `eslint .` 범위 때문에 `fin/**/*.ts` 가 CI 의 typecheck·lint·format:check 대상에 자동 포함된다. 통과 확인(`evidence/`). vitest 는 `src/**`·`tests/**` 만 수집하므로 `fin/` 은 테스트 대상 아님 |
| `.github/workflows/ci.yml`·`docker-compose.yml`·`next.config.ts`·`.env*.example` | 없음 | `next build` 의 타입 검사에도 `fin/` 이 포함되나 tsc 통과로 영향 없음 |
| `src/`·`prisma/`·`tests/`·DB 스키마·환경변수 | 없음 | `fin01.env.example` 은 새 파일이며 기존 `.env*` 규칙(`.gitignore` 의 `.env*` 차단)을 따르지 않도록 이름을 달리함 |
| 커밋 이력 | 재작성 없음 | 1차 `db2e9cc` 유지, 보완은 새 커밋 |

FIN-01 검증에 필요한 최소 변경(새 폴더 추가)만 있으며 기존 파일 변경은 0건이다(`evidence/repo-impact.txt`).

## 4. 남은 사용자 조치의 우선순위

`FIN-01_검토요청.md` §5 와 동일. 우선순위: ① 허용된 실행 환경(승인된 사내 환경) → ① 사방넷·위하고 상품·권한 확인 → ① 첫 검증 대상 1개(계정 1개 또는 비식별 샘플 1개) → ② 설계 담당자가 지정한 은행 경로·환율 출처 1종의 자격 → ② 플랫폼 읽기 권한 → ③ 전체 목록·법인 매핑 → ③ 납품 파일 위치·갱신 방식.

## 5. 외부 연동이 미확정이어도 구현 가능한 FIN-02 공통 기반의 범위와 근거

계획서 §11 FIN-02 정의("저장소, API/worker, DB, 로그인, 원본 저장, 코드 매핑, 중복/수정 기반", 완료 기준 "재수집 시 무중복, 두 법인 분리, 원본 추적, 비밀값 미노출") 안에서만 판단한다. 새 설계·기능 추가 없음.

| FIN-02 항목(§11) | 외부 응답 없이 구현 가능한 근거 | 이번 검증에서 확인한 규칙 |
|---|---|---|
| 저장소·API/worker·DB·로그인 | §3 기술 구성과 §5 테이블은 외부 API 필드에 의존하지 않음 | — |
| 원본 저장(`source_runs`/`raw_objects`) | 대상 기간·수집 시각·원천 최신일·해시·경로는 출처 무관 | 수집 시각과 원천 기준일 분리(위하고 월 단위, 광고 소급 갱신) |
| `source_records` 무중복·관측 버전 | 원천키 = 시스템+계정+ID(없으면 대체키), payload 해시 비교 | BANK-KFTC-04, SALES-SBN-03, SALES-C24-03 |
| 코드 매핑(`external_mappings`) | 원천 시스템+계정+외부 코드→내부 ID, 유효기간 | 핀테크이용번호·몰 ID·거래처 매핑, 미매핑 원본 보존 |
| 두 법인 분리 | 계정 단위 법인 매핑 | 전 샘플에서 `legalEntity` 필수 |
| 비밀값 미노출 | 환경변수명만 예시, 응답 본문 미저장 | `fin01.env.example`, `live/http.ts` |

가상 검증 코드(`verify/`)는 FIN-02 구현체가 아니며 그대로 이식 대상이 아니다. 규칙 확인용이다.

## 6. 외부 응답을 확인하기 전 확정하면 안 되는 부분

1. 모든 원천 필드명·상태 코드·엔드포인트 경로·파라미터(필드매핑표의 `SNIPPET`·`ASSUMED`·`UNVERIFIED` 전부). 특히 사방넷 전체, 카페24 주문 리소스, 오픈뱅킹 경로·파라미터명, ECOS 경로, 네이버 서명 문자열, 틱톡 파라미터 값, 메타 API 버전.
2. 오픈뱅킹 거래별 ID 부재와 대체키 구성. 일자 지정 잔액 조회 가능 여부. USD 계좌 지원 여부.
3. 결제 완료 일시·취소/환불 확정일의 원천 제공 여부(사방넷·카페24). 확인 전 임의 날짜 대체 금지.
4. 광고 5개 플랫폼의 세금 기준, 소급 갱신 기간(메타 28일·구글은 제3자/추정), 잔액 조회 경로(메타·구글·쿠팡), 쿠팡 광고 API 존재 여부, 틱톡 토큰 만료.
5. 위하고 읽기 경로 존재 여부와 제공 범위. 전표·행 ID 제공 여부.
6. 은행 후보의 회사 계정 기준 신청 자격·비용·조회 가능 기간. 환율 출처의 이용약관·비영업일 응답 형태.
7. 채널 포괄 범위(사방넷 연동 채널 목록 vs 회사 전체 채널 목록)와 채널별 담당 원천.
8. 10시 전 전일 확정 가능 여부(쿠팡 광고·납품 엑셀).
