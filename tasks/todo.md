# TODO: ha-app-memory

## Phase 0: Foundation
- [x] T1 SPEC.md 네트워크/경계/구조 교정
- [x] T2 Node/TS 프로젝트 scaffold + MCP 서버 골격 (stateless mode: McpServer 인스턴스는 요청마다 새로 생성 — SDK 공식 stateless 예제 패턴)
- [x] T3 DB 기반 — sqlite-vec 스키마
- [x] T4 임베딩 HTTP 클라이언트 기반 (재시도+backoff, mock HTTP 서버로 계약 검증)
- [x] Checkpoint A: Foundation 완료 (typecheck+lint+test green, DB/임베딩 독립 검증)

## Phase 1: 슬라이스 1 — memory.save + memory.get E2E
- [x] T5 memory.save E2E
- [x] T6 memory.get E2E
- [x] Checkpoint B: save→get 라운드트립 E2E 동작

## Phase 2: 슬라이스 2 — memory.search
- [x] T7 memory.search E2E (limit 기본값 5 / 상한 20 clamp로 확정)
- [x] Checkpoint C: 벡터+태그 필터 검색 E2E 동작

## Phase 3: 슬라이스 3 — memory.update
- [x] T8 memory.update E2E
- [x] Checkpoint D: content 변경 시에만 재임베딩 검증됨

## Phase 4: 슬라이스 4 — memory.similar
- [x] T9 memory.similar E2E
- [x] Checkpoint E: similar가 자기 자신 제외하고 정확히 동작

## Phase 5: 슬라이스 5 — memory.delete
- [x] T10 memory.delete E2E
- [x] Checkpoint F: tool 6종 전부 완료, npm test green (모델/GPU 불필요) — 28 tests, /mcp tools/list로 6종 실측 확인

## Phase 6 (개정): Docker / s6 패키징 — 외부 OpenAI 호환 Embeddings API로 전환
- [x] T11 bitnet.cpp 사이드카 feasibility 스파이크 — **종료(방향 전환)**: linux-test(aarch64)에서
      bitnet.cpp 빌드 성공, OpenAI 호환 HTTP 계약 가정도 정확했음. 하지만 실제 임베딩 값이
      다중 토큰(4개 이상) 입력에서 NaN. 레이아웃 버그 1건(microsoft/BitNet#585와 동일, 직접
      특정 후 실제 컴파일되는 코드로 fix 적용·재현 확인)은 해결했으나, 4토큰 임계값에서
      발생하는 별도 버그는 원인 미해결(4×4 GEMM 타일링 가설 검증 후 기각 — ARM은 해당
      AVX2 코드조차 컴파일되지 않음). HA 주력 실기기(Raspberry Pi, HA Green/Yellow)가 aarch64인
      점을 고려해 로컬 bitnet.cpp 추론을 포기하고 외부 OpenAI 호환 API로 전환하기로 결정.
      GitHub 이슈 미제출(추후 필요시 별도 요청). 상세 디버깅 기록은 대화 로그 참조.
- [x] SPEC.md §2/§5/§8 갱신 — bitnet.cpp 사이드카 제거, 외부 OpenAI 호환 API로 교체,
      `config.yaml` options/schema(api_key/base_url/model/embedding_dimensions) 추가 결정
- [x] T11b `src/config.ts`/`src/embedding/client.ts`에 Authorization 헤더 + 설정 가능한
      base_url/model/dimensions 반영. EMBEDDING_API_KEY 미설정 시 index.ts에서 즉시
      fail-fast(명확한 에러, 실제 확인함). 29 tests green (Authorization 헤더 검증
      테스트 추가)

## Phase 6 (재개정): 로컬 upstream llama.cpp 사이드카로 복귀
- [x] T11c BitNet 재검토 (이슈 #561/#470/#411/#585/#588, PR #551/#580/#586/#469) → **도입 불가**
      확정. 근거: ① ARM 정상 커밋(404980e, 2025-06-03)은 임베딩 모델 지원(2026-07-16)보다
      13개월 앞서 상호 배타적 ② PR #551/#586이 고치는 `src/ggml-bitnet-mad.cpp`는
      `src/CMakeLists.txt`의 `set()` 덮어쓰기 + 미참조 변수 때문에 **빌드에서 제외됨**
      (linux-test 실측과 일치) ③ 공식 임베딩 I2_S 가이드에 ARM 언급 0건(x86 Xeon 전용)
      ④ 오픈 PR 110건/이슈 304건, ARM 수정 PR 전부 리뷰 0건. 추가로 upstream llama.cpp
      직접 이식도 검토했으나, GGUF가 arch=qwen3임에도 블록당 텐서 18개(표준 11개 + BitNet
      subln 7개 `*_norm_in`)라 upstream에 없는 신규 아키텍처 이식이 필요해 기각.
- [x] T11d 임베딩 백엔드를 **upstream llama.cpp(llama-server) 로컬 사이드카 +
      Qwen/Qwen3-Embedding-0.6B-GGUF(Apache-2.0, Q8_0 609MiB)** 로 확정. 모델 GGUF 헤더 실측:
      텐서 310개(표준 qwen3), `embedding_length=1024`, `pooling_type=3(LAST)` 내장.
      SPEC.md §2/§4/§5/§8 갱신 완료.
- [x] T11e 코드 반영: `EMBEDDING_BASE_URL` 기본값 → `http://127.0.0.1:8080`,
      `EMBEDDING_DIMENSIONS` → 1024, `api_key`를 **선택 값**으로 전환(미설정 시 Authorization
      헤더 자체를 생략, 외부 API 탈출구는 유지), index.ts의 api_key fail-fast 제거.
      30 tests green (무인증 케이스 테스트 추가)
- [x] T11f aarch64 스파이크 **전부 통과** (linux-test, Debian trixie 컨테이너, 실측):
      - 입력 길이 1~512 단어 12개 지점 전부 **nonfinite 0개** (bitnet이 4토큰에서 NaN이던 지점 포함)
      - `dim=1024` 확인, 모든 벡터 `norm=1.000000` (llama-server가 L2 정규화 → 코사인에 그대로 적합)
      - 의미 분리 명확: `cos(유사)=0.8667` vs `cos(무관)=0.2867`
      - **한↔영 교차언어 `cos=0.7859`** (무관 0.2867보다 훨씬 높음) — 한국어 사용에 중요
      - 동일 입력 2회 최대 절대차 `0.000e+00` (완전 결정적)
      - 모델 sha256 `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`
      - **베이스 이미지 제약 발견**: 공식 프리빌트 바이너리는 `GLIBC_2.38`/`GLIBCXX_3.4.32`
        요구 → Debian **bookworm(2.36)에서는 실행 불가**. `base-debian:trixie`(2.41)에서 정상.
        런타임에 `libgomp1` 패키지 필요.
- [x] T11g **unix socket 전환** (보안 강화): 사이드카를 TCP가 아니라
      `/run/llama/embed.sock`(디렉토리 0700 root)에 바인딩. llama-server가
      `--host <*.sock>` 를 네이티브 지원함을 소스에서 확인. Node 쪽은 `undici`의
      `Agent({connect:{socketPath}})` 사용(전역 fetch 대신 undici fetch — 디스패처와
      같은 복사본이어야 함). "외부 미노출"이 설정 규약이 아니라 **구조적 불가능**이 됨.
      31 tests green (unix socket 연결 테스트 추가).
      **DB 분리는 기각** — SQLite는 인프로세스 라이브러리라 분리하려면 없던 리스닝
      소켓이 생겨 오히려 표면이 늘어남. SPEC §8 Never에 근거와 함께 기록.
- [x] T12 Dockerfile + s6 서비스 3종 + config.yaml + DOCS.md 작성 완료
- [x] T13 aarch64 풀 컨테이너 라운드트립 **전부 통과** (linux-test 실측):
      - `docker build` green, s6가 llama-server→mcp-server→discovery 순서로 정상 기동
      - `llama_server: listening on unix:///run/llama/embed.sock`, 소켓 권한 `srwx------ root root`
      - 실제 프로세스 인자에 `--port` 없음, TCP 8080 무응답 확인
      - `tools/list` 6종, save→get→search→similar→delete 전 경로 통과
      - **핵심 가치 실증**: 영어 질의 "what language do I like to code in?"가
        한국어로 저장된 사실을 1위로 반환 (거리 0.477 vs 무관 사실)
      - 삭제 후 `memory.get`이 `isError:true`로 명시적 실패 (무음 성공 아님)
      - Supervisor 없는 환경 대비 `/usr/lib/ha-memory/options.sh` 폴백 추가
      - 검증 스크립트를 repo에 편입: `scripts/{smoke.sh,mcp-smoke.mjs,ci-options.json}`
        (ha-app-crw의 `scripts/smoke.sh` 선례). repo 경로에서 재실행해 재통과 확인.
        `test/`는 이미지에 넣지 않는다 — Dockerfile COPY 대상이 아니고 vitest는
        `npm prune --omit=dev`로 제거되므로 이미지에서 실행 불가.
- [x] T13b 실기기 1차 설치 피드백 대응 — llama-server가 **SIGKILL(9) 무한 재시작 루프**
      - 원인 1(메모리): 임베딩 전용인데 **생성용 기본값**이 그대로 걸려 있었음.
        `CPU_REPACK` 446 MiB(가중치 사본), KV 224 MiB(슬롯 4개), prompt cache 상한 8 GiB.
        → `--parallel 1 --cache-ram 0 --no-repack --no-warmup --no-context-shift --no-webui`
        추가. **실측 VmRSS 1,386,032 kB(1.32 GiB) → 931,964 kB(889 MiB)**, 감소분이
        repack 버퍼 크기와 정확히 일치.
      - 원인 2(루프): `finish`가 signal 15에서만 halt해서 SIGKILL(9)이면 s6가 무한 재시작.
        → 시그널 사망 시 항상 halt하고, 9번이면 OOM 진단 메시지를 명시적으로 출력.
      - 주의: llama.cpp의 `--fit`은 **호스트** 여유 메모리(/proc/meminfo)를 보므로 컨테이너
        cgroup 한도를 모른다. "no changes needed"가 떠도 OOM이 날 수 있음. DOCS에 기록.
      - DOCS에 저용량 대안(q5_k_m 425 MiB / q4_k_m 376 MiB) sha256과 함께 추가.
      - 재검증: aarch64 스모크 전 항목 통과, `n_slots = 1` 확인.
- [x] T13c 실기기 2차 피드백 — **OOM 수정 확인됨**(실기기에서 SIGKILL 없이 `mcp-server
      listening`까지 도달, `n_slots = 1` / `prompt cache is disabled` / `1128 MiB = 603+224+300`).
      로그 볼륨 과다 문제로 `debug_logging`(bool) → **`log_level`**(HA 표준 7단계)로 교체:
      - llama.cpp는 `--verbose`(threshold=INT_MAX, 텐서 310개 전수 덤프) 대신 `--verbosity N`
        사용. 매핑 `fatal 0 / error 1 / warning 2 / notice·info 3 / debug 4 / trace 5`
        (llama.cpp는 값이 낮을수록 조용함)
      - Node 쪽도 `LOG_LEVEL`로 동일 단계 적용 (`src/log.ts`). info 미만이면 tool 호출 로그
        생략, error 미만이면 에러도 생략. 잘못된 값은 info로 폴백.
      - **실측: 기동 로그 수천 줄 → 약 30줄**, 유용한 줄(`model loaded`,
        `listening on unix://`, `n_slots = 1`)은 전부 유지
      - 36 tests green (로그 레벨 게이팅 5건 추가), aarch64 스모크 전 항목 통과
- [ ] **amd64 미검증** — linux-test는 `linux/arm64` 전용이고 binfmt 에뮬레이션이 없어
      교차 빌드 불가. Dockerfile의 amd64 분기(llama.cpp x64 에셋 sha256, `sqlite-vec-linux-x64`)는
      정적으로만 확인됨. 실제 amd64 HA 인스턴스나 CI에서 1회 빌드 검증 필요.
- [ ] T12-old (참고) 확정된 제약:
      - 베이스 `ghcr.io/home-assistant/base-debian:trixie-*` (bookworm 불가), `libgomp1` 설치
      - llama.cpp는 소스 빌드 대신 **공식 릴리스 프리빌트 + sha256 검증** (ha-app-crw의
        crw-server 패턴 그대로), 아치별 에셋 `llama-<build>-bin-ubuntu-{arm64,x64}.tar.gz`
      - s6 3종: `llama-server`(longrun, 127.0.0.1 바인딩) / `mcp-server`(longrun, health 폴링 후 기동)
        / `discovery`(oneshot, OHF-Voice `voice/rootfs`의 discovery 서비스 패턴 채택)
      - `config.yaml`: `ports: {"8099/tcp": null}`(내부 전용), `discovery: [mcp]`, `init: false`,
        options로 모델 repo/파일·threads 노출 (OHF-Voice `voice/config.yaml` 선례)
      - 모델은 `/data`에 런타임 다운로드 + sha256 검증
- [ ] T13 풀 컨테이너 라운드트립 (discovery announce, config.yaml options/schema,
      로컬 사이드카로 save→search 실측, 사이드카 재시작 복구 / 영구 실패 시 halt 검증)
- [ ] Checkpoint G: linux-test 2아치 빌드 green, 로컬 임베딩으로 save→search 동작,
      사이드카 장애 2종(일시/영구) 설계대로 동작

## Phase 7: End-to-end HA 통합 검증
- [x] T14 HA Supervisor discovery + Assist 대화 스모크 **통과** (실기기 파이프라인 트레이스)
- [x] **Checkpoint H 달성** — 핵심 가치 실기기 입증:
      - 턴 1(한국어) "내가 가장 선호하는 언어는 한국어야. 기억해 줘." → `memory.save`
      - 별도 대화 턴(영어) "What is my favorite language?" → `memory.search`
        → distance 0.4376으로 회수 → "Your favorite language is Korean"
      - `conversation_id`가 다른 대화를 건너 기억이 유지되고, **한국어로 저장한 사실을
        영어 질의로 회수**함 (T11f 스파이크의 교차언어 수치가 실사용에서 재현)
      - `memory.update`도 실사용 확인: 한국어 content가 LLM→HA→MCP→SQLite→응답까지
        **바이트 단위로 온전히 왕복**
- [x] MCP `serverInfo.name`을 `ha-app-memory`(npm 패키지명) → **`Memory`** 로 수정.
      `config.yaml`의 `name`과 일치. 스모크에 `initialize` 검증 단계 추가(회귀 방지).
- [x] tool description 보강 — 실사용에서 LLM이 한국어 입력을 **영어로 번역해 저장**하는
      문제가 관측됨. `save`/`update`에 "사용자가 쓴 언어를 유지하고 번역하지 말 것",
      "단독으로 읽어도 이해되는 완결 문장으로", "tags는 content에 이미 있는 단어 말고
      넓은 주제 라벨로" 지침 추가. `search`에는 교차언어 매칭 가능함을 명시.

- [x] **tool 이름에서 `.` 제거 (OpenAI 400 오류 수정)** — `memory.save` → `memory_save` 등 6종.
      OpenAI 함수 이름 패턴이 `^[a-zA-Z0-9_-]+$`라 점을 허용하지 않는다. HA는 MCP tool 이름을
      함수 이름으로 그대로 전달하므로, 하나만 어긋나도 **요청 전체가 400으로 거부되어 해당
      대화 턴이 통째로 실패**한다(`Invalid 'tools[N].name'`). SPEC §3의 원래 표기가 점이었으나
      외부 API 제약이라 변경 불가피.
      회귀 방지로 `test/tools/naming.test.ts` 추가 — `tools/list` 결과의 모든 이름을 해당
      정규식으로 검증하고, 노출 tool 6종 목록도 고정. 38 tests green.

- [x] 옵션 3건 개정 + DB 안전성 검증
      - `log_level`, `model_sha256`을 **선택 옵션**으로 전환(`schema`에 `?`, `options:`에서 제외
        → HA UI에서 기본 숨김). 미설정 시 각각 `info` 적용 / 검증 생략 + 실제 해시 출력.
        `options.sh`가 bashio의 `"null"`을 빈 값으로 정규화.
      - **차원 변경 시 DB 동작 실측**: `CREATE VIRTUAL TABLE IF NOT EXISTS`가 기존 폭을
        조용히 유지 → 기동은 성공하고 이후 **모든 save/search가 런타임 실패**
        (`Dimension mismatch ... Expected 1024, received 768`). `openDb()`에 개방 시점
        가드 추가(`DimensionMismatchError`, 양쪽 값을 모두 명시). test/db/dimension.test.ts
        4건: 동일 폭 정상 / 변경 시 즉시 거부 / **거부 후 데이터 무손실**(되돌리면 복구) /
        신규 DB는 설정값 채택. 42 tests green.
      - 같은 폭에서 모델만 바꾸는 경우는 DB로 탐지 불가 → 아래 `meta` 테이블로 해결.
- [x] **`meta` 테이블 추가 (사용자 승인, SPEC §8 Ask First)** — `meta(key,value)`에
      `embedding_model`(= `model_file`)을 기록해, DDL이 알 수 없는 "같은 폭 다른 모델" 교체를
      탐지. 기존 기억이 조용히 안 잡히는 것이 가장 위험한 경우라 이를 막는 것이 목적.
      - `meta` 행이 없는 구버전 DB는 현재 모델을 채택(추측하지 않음) — 마이그레이션 경로
      - 검사를 **`db-check` oneshot**으로 분리해 mcp-server보다 먼저 실행. longrun에서
        던지면 또 크래시 루프가 되므로, `S6_BEHAVIOUR_IF_STAGE2_FAILS=2` 경로를 재사용.
      - 47 tests green (모델 관련 5건 추가: 기록/동일 모델 정상/교체 거부/거부 후 데이터
        무손실/구버전 DB 채택)
      - **컨테이너 실측**: meta를 다른 모델로 바꾸고 기동 → db-check가 양쪽 모델명을 밝힌
        메시지 출력 → **4초 만에 `ExitCode=1` 정지**, `facts` 행 수 그대로 보존 확인.
- [x] **재임베딩 마이그레이션 구현** (`db-migrate` oneshot) — 모델/차원이 바뀌면 거부하는 대신
      저장된 fact의 content로 **전부 재임베딩**. `db-check`는 이걸로 대체.
      - 서비스 순서: `model-download` → `llama-server` → **`db-migrate`** → `mcp-server` → `discovery`.
        s6는 start만 정렬하므로 db-migrate가 소켓 health를 폴링한 뒤 진행.
      - 모델 식별자 동일 → `up-to-date`로 통과(사이드카 호출 0회). 다르면 재임베딩.
      - **원자성**: 임베딩을 전부 계산한 *뒤* 한 트랜잭션으로 기록(DROP/CREATE vec_facts +
        전체 insert + meta 갱신). 도중 실패 시 DB는 손도 안 댄 상태 → 반쯤 마이그레이션된
        상태가 존재할 수 없음.
      - 차원 변경도 같은 경로로 해결(vec0는 폭 고정이라 테이블 재생성 필요).
      - `meta` 없는 구버전 DB는 **추측하지 않고 재임베딩**(현재 모델 가정 시 조용히 깨질 위험).
      - `openDb()`의 가드는 안전망으로 유지, 마이그레이션만 `unchecked` 옵션으로 우회.
      - 54 tests green (마이그레이션 7건: 동일 모델 통과·모델 변경 재임베딩·차원 변경 테이블
        재생성·facts 원문 보존·중간 실패 시 무변경·구버전 DB 재임베딩·빈 DB 통과)
      - **컨테이너 실측**: 사실 3건 저장 → meta를 다른 모델로 변경 → 재기동 시
        `re-embedded 1/3, 2/3, 3/3` → `migrated 3 facts — embedding model changed(...)` →
        재임베딩 후에도 영어 질의로 한국어 사실 검색 성공(distance 0.359), meta 갱신 확인.
- [x] **설정 오류 시 무한 재시작 루프 수정** (검증 중 발견)
      - 증상: 잘못된 `model_sha256`/`model_repo`면 llama-server가 exit 1 → s6가 즉시 재시작
        → **609MB를 계속 재다운로드**. 실측 62회/80초, 컨테이너는 계속 running.
      - `finish`의 `exec /run/s6/basedir/bin/halt`는 수동 실행 시엔 동작하지만(4초 내 정지),
        크래시 루프 중에는 종료 시퀀스가 시작조차 안 됨(`stopping` 로그 0건,
        이후 `unable to talk to shutdownd: Operation not permitted`).
      - 해결: 모델 준비를 longrun에서 분리해 **`model-download` oneshot**으로 이동 +
        Dockerfile에 `ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2`. oneshot은 재시도되지 않고
        실패 시 s6-rc가 컨테이너를 정지시킨다.
      - 실측 결과: 잘못된 repo → **62회 → 1회**, 4초 만에 `ExitCode=1` 정지.
        체크섬 불일치 → 1회 다운로드 후 26초 만에 정지. 정상 경로 스모크 전 항목 통과.
      - 부수 효과: s6 기동 순서가 실제 준비 순서와 일치하게 됨
        (`model-download` 완료 → `llama-server` → `mcp-server` → `discovery`),
        curl 진행률 막대도 로그에서 제거(`-sS`).

- [x] **업스트림 핀 정리 + 자동 PR 워크플로**
      - 드리프트 발견: `sqlite-vec`가 `^0.1.7-alpha.2`인데 실제 **0.1.9** 설치됨,
        `better-sqlite3`도 `^12.4.1` → 12.11.1. 둘 다 **정확 핀**으로 전환
        (native/loadable-extension 쌍이라 잘못된 조합이 런타임에만 드러남).
        순수 JS 의존성(MCP SDK/zod/undici)은 caret 유지 — 테스트가 잡아줌.
      - llama.cpp는 이미 `ARG LLAMA_BUILD` + 아치별 sha256으로 핀되어 있었고,
        **릴리스 API digest와 일치함을 실측 확인**(`31a607f2…`, `16d63bfb…`).
      - `.github/workflows/upstream-pins.yml` 추가 (주 1회 + 수동 실행):
        · `llama-cpp` job — 최신 릴리스와 비교 → Dockerfile의 3개 ARG를 sed로 갱신 →
          `deps/llama-cpp-<tag>` 브랜치로 PR. sha256은 **재계산이 아니라 릴리스 API의
          digest**를 그대로 기록.
        · `npm-pins` job — `sqlite-vec`/`better-sqlite3` 최신 비교 → `--save-exact` 갱신 →
          **typecheck+lint+test 통과한 경우에만** PR 생성.
        · 동일 브랜치 PR이 이미 있으면 건너뜀(중복 방지).
        · 두 PR 본문 모두 "머지 전 `scripts/smoke.sh` 실행" 안내 — 유닛 테스트만으로는
          네이티브/이미지 동작을 보증하지 못하므로.
      - 검증: YAML 파싱 + 7개 `run` 블록 전부 `bash -n` 통과, GNU sed 치환 3줄 정확,
        릴리스 API 쿼리 실측, PR 본문 렌더링 확인.

### 애드온 밖 이슈 (우리 범위 아님, 기록용)
- 대화 에이전트 `conversation.free_models_router`가 **간헐적으로** 불량 출력:
  - tool 인자 JSON 파손 → HA(Python)에서 `Expecting value: line 1 column 56 (char 55)`
    로 실패. 우리 서버는 호출조차 받지 못함.
  - content 문자 깨짐(`한국언식은시`), 응답에 타 언어 토큰 혼입(`أي, aufgebaut從哪里`)
  - 항상 깨지는 게 아니라 확률적 — 같은 파이프라인에서 한국어 `memory.update`는 정상 왕복.
    → 시스템적 인코딩 버그가 아니라 모델/라우터 문제. **대화 에이전트 모델 교체 권장.**
