# FIN-01 자동 수집 연동 검증

기준 문서: `FIN_개발계획_v1.0.md`(2026-09-14) §4·§5·§10·§13·§14.
이 폴더는 FIN-01 검증 전용이며 기존 SCM/WMS 코드(`src/`, `prisma/`)를 변경하지 않는다.

## 제출물

| 파일 | 내용 |
|---|---|
| `FIN-01_연동검증표.md` | 출처별 검증 상태·공식 근거·이용 가능 여부·필드·제한·인증·비용·다음 조치 |
| `FIN-01_필드매핑표.md` | 계획서 §4 필수 필드 ↔ 원천 필드 대응, 변환, 누락, 근거 수준 |
| `FIN-01_실행결과.md` | 실행 시각·대상 기간·계정 별칭·건수/금액 대조·재조회·오류·재현 방법 |
| `FIN-01_검토요청.md` | 확인 완료/미검증/미충족/선택 필요/사용자 조치/FIN-02 착수 가능 여부 |
| `verify/` | 검증 코드(TypeScript, 저장소 tsconfig·eslint·prettier 통과) |
| `samples/` | 비식별 **가상** 샘플(`_meta.synthetic: true`). 실제 원천 응답 아님 |
| `results/` | 실행 결과 JSON(가상 데이터 검증 `fixture-run.json`, 실제 호출 시도 `live-run*.json`) |
| `fin01.env.example` | 실제 호출용 환경변수 이름 예시(값 없음) |

## 실행

```bash
pnpm install --frozen-lockfile

# 1) 가상 샘플 검증(자격·네트워크 불필요). 결과: results/fixture-run.json
pnpm tsx fin/FIN-01/verify/run.ts

# 2) 실제 호출 시도(환경변수 필요). 결과: results/live-run.json
cp fin/FIN-01/fin01.env.example .env.fin01   # .env* 는 .gitignore 대상
#   .env.fin01 에 값 입력 후
set -a && . ./.env.fin01 && set +a
pnpm tsx fin/FIN-01/verify/run.ts --live all --date 2026-09-12
pnpm tsx fin/FIN-01/verify/run.ts --live fx-exim --date 2026-09-12
```

종료 코드: 가상 검증 실패 시 1, 실제 호출 중 OK 가 아닌 소스가 있으면 2.

## 규칙

- 비밀값·개인정보를 저장소에 넣지 않는다. 실제 호출 결과도 본문을 저장하지 않고 상태·건수·해시만 남긴다.
- 가상 데이터 검증은 항상 `synthetic: true` 로 표시되며 실제 연동 성공을 뜻하지 않는다.
- 필드매핑의 근거 수준: `CONFIRMED`(원문/실제 응답) · `SNIPPET`(공식 문서 검색 발췌, 원문 미열람) · `ASSUMED`(문서 미확인, 자리표시자) · `MISSING`(원천 미제공).
- 금액은 문자열 + BigInt 고정 스케일로만 연산한다(`verify/decimal.ts`). 부동소수점 사용 금지.

## 구조

```
verify/
  decimal.ts      정밀 십진수(문자열·BigInt)
  types.ts        계획서 §5 표준 레코드(검증용 최소 필드)
  mapping.ts      원천→표준 매핑 명세·payload 해시·원천키
  dedupe.ts       source_records 재수집 무중복·관측 버전
  reconcile.ts    건수·금액 대조, 검증 항목 결과
  time.ts         원천 시간대→UTC, 영업일 보조
  samples.ts      가상 샘플 로더(synthetic 강제)
  sources/        출처별 매핑 명세 + 가상 샘플 검증
  live/           실제 호출 시도(자격 없으면 BLOCKED 로 기록)
  run.ts          실행기
```
