# FIN-02A/B GitHub Actions 실행 결과 (설계 담당자 요청 증빙)

조회 수단: GitHub API(Actions 목록·잡·로그). 조회 시각 2026-09-14 13:1x UTC. 로컬 검사 결과와 분리해 기록한다.

| 커밋 | 내용 | 워크플로 실행 | 결과 | 비고 |
|---|---|---|---|---|
| `db2e9cc` | FIN-01 1차 | https://github.com/shearts0126/Junhyeok/actions/runs/34835426457 | success | — |
| `70ebb4d` | FIN-01 2차 보완 | https://github.com/shearts0126/Junhyeok/actions/runs/34837455563 | **failure** | 루트 `verify` 잡의 `DB integration tests` 단계에서 기존 SCM/WMS 시험 `tests/db/supplier-api.test.ts` 95번(동시 versioning) 실패. `fin/` 변경과 무관한 기존 코드의 간헐 실패 |
| `591ad87` | FIN-02A 1차 | https://github.com/shearts0126/Junhyeok/actions/runs/34838763866 | success | — |
| `ee3a30a` | FIN-02A 보완 | https://github.com/shearts0126/Junhyeok/actions/runs/34840880583 | success | — |
| `b068ce8` | FIN-02A 최종 보완 | https://github.com/shearts0126/Junhyeok/actions/runs/34843960068 | **failure** | 위와 동일한 SCM/WMS 시험(95번) 간헐 실패. typecheck·lint·format·unit 은 통과, DB 통합 단계에서 실패해 이후 단계(drift·build)는 skipped |
| `1079d66` | FIN-02B | https://github.com/shearts0126/Junhyeok/actions/runs/34844674866 | success | `verify` 잡 성공 + 신규 `fin02a (independent checks)` 잡 성공(typecheck·lint·format·test 전부 success) |
| `b99578e`, `eb393bc`, `608f0ac` | FIN-02A/B 증빙 · FIN-01 환율 · FIN-02C | https://github.com/shearts0126/Junhyeok/actions/runs/34847502100 | success | 세 커밋을 연속 푸시해 Actions 는 HEAD `608f0ac0941a47c08ca164555fc65841907dd910` 기준 실행 1건만 생성됨(중간 커밋 개별 실행 없음). `verify` 잡 13단계 전부 success(DB 통합 시험 포함, 13:09:38–13:12:20 UTC), `fin02a (independent checks)` 잡 success(Redis 서비스 포함, Tests 단계 13:10:12–13:10:20 UTC). 조회 시각 2026-09-14 13:2x UTC |
| `de10ed0` | 증빙 문서만 변경(diff: `FIN-02AB_CI결과.md` 1파일) | https://github.com/shearts0126/Junhyeok/actions/runs/34848158934 | **failure** | `fin02a (independent checks)` success. `verify` 잡의 `DB integration tests` 단계에서 기존 SCM/WMS 시험 `tests/db/supplier-api.test.ts` 95번(동시 versioning) 실패(1 failed / 1213 passed). 코드 변경이 전혀 없는 커밋에서 재현됨 |
| `491e9ca`, `14b5c6b` | FIN-02A/B/C 4차 보완 · FIN-01 환율 문서 | https://github.com/shearts0126/Junhyeok/actions/runs/34897381944 | **failure** | HEAD `14b5c6b1e03495884c8c16f49ab033722a4a8d36` 기준 실행 1건. `fin02a (independent checks)` 잡 success(typecheck·lint·format·test 62건, Redis 포함, 21:11:35–21:12:22 UTC). `verify` 잡은 typecheck·lint·format·unit 통과 후 `DB integration tests` 에서 같은 95번 시험 실패, 이후 drift·build skipped. 조회 시각 2026-09-14 21:16 UTC |
| `7afd368` | 증빙 문서만 변경(자동 실행, 재실행 아님) | https://github.com/shearts0126/Junhyeok/actions/runs/34897739061 | success | `verify` 13단계 전부 success(DB integration·drift·build 포함), `fin02a` success. 같은 SCM 시험 95번이 이 실행에서는 통과 |
| `7fe5e34` | FIN-02C 큐 상태 경합 확인(requeueJob/markQueued 조건 강화, 시험 2건) | https://github.com/shearts0126/Junhyeok/actions/runs/34898651538 | success | HEAD `7fe5e344bf4148b6ca8ae0f2a5976d1f13165b8f`. `verify` 13단계 전부 success(21:24:47–21:27:32 UTC), `fin02a` success(test 64건, 21:25:20–21:25:31 UTC). 조회 시각 2026-09-14 21:30 UTC |
| `81cf5fd` | 증빙 문서만 변경(자동 실행) | https://github.com/shearts0126/Junhyeok/actions/runs/34898970447 | **failure** | `fin02a` success. `verify` 는 `DB integration tests` 에서 기존 SCM 시험 95번 실패, drift·build skipped(미실행). 코드 변경 없는 커밋에서 재현 |
| `6fb69c1` | FIN-02C 재시도 예정 시각 준수(조건부 시작 DB 시각 검사, 조기 전달 예약 보존, 시험 3건) | https://github.com/shearts0126/Junhyeok/actions/runs/34901785881 | success | HEAD `6fb69c16724c808a3a7112ce49693942d0013a08`. `verify` 13단계 전부 success(21:59:37–22:02:18 UTC), `fin02a` success(test 67건, 22:00:07–22:00:18 UTC). 조회 시각 2026-09-14 22:05 UTC |

판단(4차 검토 표현 정정): 실패 2건은 **기존 간헐 실패로 추정**하며, 이번 변경과의 인과관계는 **미확정**이다. 같은 시험이 동일 SCM 코드로 `591ad87`·`ee3a30a`·`1079d66`·`608f0ac` 에서 통과한 것은 참고 근거이지 원인 확정이 아니다. 지시(기존 SCM/WMS 업무 코드·DB 미변경)에 따라 수정·반복 실행하지 않았고 관찰 사항으로 남긴다. 기존 SCM 시험 95번 실패는 `70ebb4d`·`b068ce8`·`de10ed0`·`14b5c6b` 에서 재현되고 `591ad87`·`ee3a30a`·`1079d66`·`608f0ac`·`7afd368`·`7fe5e34`·`6fb69c1` 에서는 통과했다(`81cf5fd` 에서 다시 실패). `14b5c6b` 실행에서 drift·build 가 skipped 인 것은 통과가 아니라 미실행이다. **기존 간헐 실패로 추정, 이번 변경과의 인과관계 미확정**(문서만 바꾼 `de10ed0` 에서도 실패한 점은 참고 근거). SCM 코드 수정·재실행은 지시에 따라 하지 않았다. `fin02a` 잡은 모든 실행에서 success 다.
