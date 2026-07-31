# Implementation Plan: ha-app-memory

SPEC.md(교정 예정: Ingress→discovery, memory/ 서브디렉토리 중첩) 기준.
Phase 0~7을 15개 태스크로 분해.

> **2026-07-31 개정**: Task 11(bitnet.cpp feasibility spike)에서 aarch64 ARM
> i2_s 커널의 다중 토큰 NaN 버그(원인 일부만 특정, 완전 해결 실패)를 발견.
> HA 주력 실기기가 aarch64인 점을 고려해 로컬 bitnet.cpp 추론을 포기하고
> 외부 OpenAI 호환 Embeddings API로 전환(사용자 결정). Phase 6 태스크들과
> Architecture Decisions를 이에 맞춰 갱신. Phase 0~5(전체 6개 MCP tool)는
> 이 변경의 영향을 받지 않음(EmbeddingClient 인터페이스로 이미 격리됨).

## Overview

개인 fact(메모리)를 벡터 유사도(sqlite-vec, cosine) + 태그 필터로 저장/검색
하는 MCP 서버를 HA Assist conversation에 공급하는 애드온. Node/TS +
@modelcontextprotocol/sdk(Streamable HTTP) + 외부 OpenAI 호환 Embeddings
API(HTTP로 통신, 컨테이너 내 로컬 사이드카 없음). 패키징은 ha-app-crw
(레퍼런스, Python/FastMCP)의 s6-overlay 서비스 패턴을 재사용. 빌드/컨테이너
검증은 전부 linux-test container machine에서 수행(이 Mac은 nested
virtualization 불가, 글로벌 CLAUDE.md 참조).

## Architecture Decisions (Plan에서 확정, 사용자 승인됨)

- 저장소 구조: repo 루트(SPEC.md, tasks/, .agents/) + `memory/` 서브디렉토리에
  실제 애드온(config.yaml, Dockerfile, src/, ...) — ha-app-crw와 동일 규약
- MCP 노출: Ingress 아님. `discovery: [mcp]` + 내부 전용 포트(호스트 미게시),
  s6 서비스가 `bashio::discovery`로 Supervisor에 announce
- s6-overlay v3(`s6-rc.d`), longrun 서비스 **1개**: `mcp-server`(Node) —
  사이드카 없음(외부 API 사용). readiness 폴링 불필요, 요청 시점 재시도만으로
  일시적 API 장애 흡수(Task 4의 `EmbeddingClient` 재시도+backoff 그대로 유효)
- DB: `facts` 테이블 + `vec_facts`(sqlite-vec vec0, `distance_metric=cosine`),
  id로 join. 마이그레이션 프레임워크 없음(스키마 변경은 SPEC §8 Ask-First 항목)
- 태그 필터: KNN과 임의 WHERE 사전 필터 합성이 안전하지 않으므로, top-K를
  넉넉히(`max(limit*10, 50)`, 상한 있음) 뽑은 뒤 애플리케이션 레이어에서 태그
  ANY-match 후필터링 → limit개 반환
- 임베딩 API 계약: OpenAI 호환 `POST {base_url}/v1/embeddings` +
  `Authorization: Bearer {api_key}` — T11 스파이크에서 이 계약 가정 자체는
  정확했음(bitnet.cpp 로컬 사이드카가 동일 계약을 노출했음), 이제 외부
  실제 서비스로 요청 대상만 전환. `embedding/client.ts`의 `HttpEmbeddingClient`
  구조 그대로 재사용(Task 11b에서 인증 헤더만 추가)
- 모델/차원: 로컬 모델 가중치 관리 불필요(외부 서비스가 소유). 임베딩
  차원은 provider별로 다르므로 `config.yaml` `options`(`embedding_dimensions`)로
  노출, DB 스키마 초기화 시 사용
- 로깅: tool 호출마다 tool명/fact id/content 길이/tags 개수만 기록, 원문 미기록
- `finish` 스크립트: ha-app-crw 패턴 그대로 재사용(exitcode≠0,≠256 → halt)
- config.yaml에 `options`/`schema` 블록 **추가**(v1 원안은 "없음"이었으나
  외부 API 전환으로 `api_key`(password 타입, 필수), `base_url`/`model`/
  `embedding_dimensions`(선택, 기본값 OpenAI) 필요해짐

## Dependency Graph

```
T1 SPEC.md 교정(Ingress→discovery,          T2 Node/TS scaffold + MCP 서버
   memory/ 중첩) [문서만, 독립]                  골격(tool 0개)
                                                      │
                                                      ├─ T3 DB 기반(sqlite-vec 스키마)
                                                      ├─ T4 임베딩 클라이언트 기반(mock 계약)
                                                      └─ T11 bitnet.cpp 스파이크(종료→API 전환) ┐
                                                                                              │ (Node 코드 무의존,
                                                                                              │  Phase 1~5와 병렬)
        Checkpoint A ─────────────────────────────────────────────────────────────────────┤
                                                                                              │
T3,T4 ─┬─ T5 memory.save E2E ──┐                                                             │
       └─ T6 memory.get E2E ───┤ ← 슬라이스 1(저장+조회)   Checkpoint B                       │
                                │                                                              │
T5,T6 ──── T7 memory.search E2E ─── ← 슬라이스 2(검색)      Checkpoint C                       │
                                │                                                              │
T5,T6,T7 ── T8 memory.update E2E ── ← 슬라이스 3(수정)      Checkpoint D                       │
                                │                                                              │
T6,T7 ────── T9 memory.similar E2E ← 슬라이스 4(유사)       Checkpoint E                       │
                                │                                                              │
T6 ────────── T10 memory.delete E2E ← 슬라이스 5(삭제)      Checkpoint F                       │
                                │                                                              │
                                └── (tool 6종 전부 완료) ────────┐                             │
                                                                   │                             │
                                                    T11 ── T11b 임베딩 클라이언트 인증/설정 반영
                                                                    └─ T12 Dockerfile + mcp-server 단일 서비스
                                                                              └─ T13 풀 컨테이너 라운드트립
                                                                                    (실제 외부 API)
                                                                                    Checkpoint G
                                                                                          │
                                                                                    T14 HA Supervisor
                                                                                    discovery + Assist E2E
                                                                                    Checkpoint H
```

---

## Task List

### Phase 0: Foundation

#### Task 1: SPEC.md 네트워크/경계/구조 교정

**Description:** SPEC.md의 "HA Ingress를 통해서만 노출" 서술을 실제 검증된
Supervisor MCP discovery 패턴(`discovery: [mcp]` + 내부 전용 포트, 호스트
미게시)으로 교정한다. 대상: §1 Objective, §8 Always/Ask First/Never의 Ingress
언급 전체. §5 Project Structure를 `memory/` 서브디렉토리 중첩 구조 + s6-overlay
`s6-rc.d`(구식 `services.d` 아님)로 갱신한다.

**Acceptance criteria:**
- [ ] §1, §8의 Ingress 언급이 전부 "Supervisor discovery(`discovery: [mcp]`),
      포트는 내부 네트워크 전용으로 선언되고 외부 매핑하지 않음" 서술로 대체됨
- [ ] §5가 `memory/` 서브디렉토리 중첩 구조 + `s6-rc.d` 서비스 2개 구조로 갱신됨

**Verification:**
- [ ] `grep -ni ingress SPEC.md` 결과 없음

**Dependencies:** None · **Files:** SPEC.md · **Scope:** S

#### Task 2: Node/TS 프로젝트 scaffold + MCP 서버 골격

**Description:** `memory/` 서브디렉토리에 `package.json`(scripts: `dev` [tsx
watch], `build` [tsc], `typecheck` [tsc --noEmit], `lint` [eslint], `test`
[vitest run]), `tsconfig.json`(strict), ESLint+Prettier 기본 설정, Vitest
설정을 만든다. `src/index.ts`가 `@modelcontextprotocol/sdk`로 Streamable HTTP
transport MCP 서버를 띄우되 tool은 아직 0개(초기화 요청에만 응답). 공용
`src/log.ts`(길이/개수만 로깅) 골격도 이때 만든다.

**Acceptance criteria:**
- [ ] `npm install && npm run typecheck && npm run lint && npm test` 전부 통과
- [ ] `npm run dev`로 뜬 서버에 MCP `initialize` 요청 시 정상 응답
- [ ] `src/tools/`, `src/db/`, `src/embedding/`, `src/config.ts`, `src/log.ts`
      스텁 존재(이후 태스크가 채움)

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test`
- [ ] MCP TS SDK `Client` + `StreamableHTTPClientTransport`로 로컬 서버에
      `initialize` 호출 스크립트 실행 → 성공 응답 확인

**Dependencies:** None · **Files:** memory/package.json, tsconfig.json,
eslint config, vitest.config.ts, src/index.ts, src/log.ts · **Scope:** M

#### Task 3: DB 기반 — sqlite-vec 스키마

**Description:** `src/db/schema.ts`(DDL: `facts(id TEXT PK, content TEXT,
tags TEXT, created_at, updated_at)` + `CREATE VIRTUAL TABLE vec_facts USING
vec0(id TEXT PRIMARY KEY, embedding float[N] distance_metric=cosine)`),
`src/db/client.ts`(better-sqlite3로 파일 open, `sqlite-vec` npm 패키지의
`getLoadablePath()`로 확장 로드). 아직 tool과 연결하지 않음(순수 DB 레이어).

**Acceptance criteria:**
- [ ] 임시 sqlite 파일에 스키마 적용 → `facts`/`vec_facts` 둘 다 생성 확인
- [ ] 임베딩 차원 N은 `src/config.ts`의 상수 하나로 관리(모델 교체 시 한 곳만
      수정하면 되도록)
- [ ] insert/get/delete 원시 함수(SQL 파라미터 바인딩만 사용, 문자열 결합 금지)

**Verification:**
- [ ] `vitest run test/db/schema.test.ts` — 실제 임시 sqlite 파일 + sqlite-vec
      로드 성공, insert 후 벡터 컬럼 조회 가능

**Dependencies:** T2 · **Files:** memory/src/db/schema.ts, src/db/client.ts,
src/config.ts, test/db/schema.test.ts · **Scope:** M

#### Task 4: 임베딩 사이드카 HTTP 클라이언트 기반

**Description:** `src/embedding/client.ts` — 사이드카에 HTTP로 임베딩을
요청하는 클라이언트. OpenAI 호환 `POST /v1/embeddings` 가정으로 진행하고
`src/embedding/types.ts`에 ASSUMPTION 주석을 남긴다(T11에서 재확인/조정).
요청-시점 재시도(backoff, 상한 횟수)를 이 클라이언트에 내장 — 실패 시 명확한
에러로 변환(무음 실패 금지). 127.0.0.1 이외 호스트로는 나가지 않도록 설정값
주입 방식으로만 구성(하드코딩 금지).

**Acceptance criteria:**
- [ ] mock HTTP 서버(사이드카 대역) 상대로 요청/응답 포맷 계약 테스트 통과
- [ ] 재시도 정책(횟수/backoff 간격) 단위 테스트로 검증(예: 2회 실패 후 3회차
      성공 시 결과 반환, 상한 초과 시 명확한 에러 throw)
- [ ] 사이드카 호스트/포트가 설정값으로만 주입됨(하드코딩 없음)

**Verification:**
- [ ] `vitest run test/embedding/client.test.ts`(mock HTTP 서버 사용, 실제
      모델 불필요)

**Dependencies:** T2 · **Files:** memory/src/embedding/client.ts,
src/embedding/types.ts, test/embedding/client.test.ts · **Scope:** M

### Checkpoint A (Foundation 완료)
- [ ] `npm run typecheck && npm run lint && npm test` 전부 green
- [ ] DB 스키마 + 임베딩 클라이언트가 각각 독립적으로 실제 sqlite / mock HTTP
      상대 테스트 통과(아직 tool로 연결 안 됨) · 사용자 보고

### Phase 1: 슬라이스 1 — memory.save + memory.get E2E

#### Task 5: memory.save E2E

**Description:** Zod 스키마(`{content: string, tags?: string[]}`) →
`src/tools/save.ts` → 임베딩 클라이언트 호출(T4) → `src/db/facts.ts`의 insert
(facts + vec_facts 동일 트랜잭션) → id 반환. MCP 서버(T2)에 tool로 등록. 호출
로그는 content 길이/tags 개수만.

**Acceptance criteria:**
- [ ] 정상 입력 시 uuid id 반환, DB에 facts+vec_facts 양쪽 행 생성 확인
- [ ] Zod 검증 실패(content 누락 등) 시 명확한 MCP tool error, DB에 아무것도
      쓰이지 않음
- [ ] 임베딩 클라이언트 실패 시(mock으로 강제) DB에 부분 쓰기가 남지 않음
      (트랜잭션 원자성)

**Verification:**
- [ ] `vitest run test/tools/save.test.ts` — MCP SDK `Client`로 실제
      `tools/call memory.save` 호출, 임베딩은 mock 사이드카

**Dependencies:** T3, T4 · **Files:** memory/src/tools/save.ts,
src/tools/schemas.ts, src/db/facts.ts(insert), test/tools/save.test.ts ·
**Scope:** M

#### Task 6: memory.get E2E

**Description:** Zod 스키마(`{id: string}`) → DB 단일 조회. 존재하지 않는
id는 명확한 not-found 에러(빈 문자열/undefined로 조용히 넘기지 않음).

**Acceptance criteria:**
- [ ] `memory.save`로 만든 fact를 `memory.get`으로 그대로 조회(content, tags,
      created_at/updated_at 포함)
- [ ] 존재하지 않는 id → 명시적 에러, 서버 크래시 없음
- [ ] Zod 검증 실패 케이스(id 누락/타입 오류) 테스트

**Verification:**
- [ ] `vitest run test/tools/get.test.ts`

**Dependencies:** T3, T5(save가 만든 fixture로 라운드트립 검증) ·
**Files:** memory/src/tools/get.ts, src/db/facts.ts(select),
test/tools/get.test.ts · **Scope:** S

### Checkpoint B (슬라이스 1)
- [ ] `memory.save` → `memory.get` 라운드트립이 MCP 클라이언트를 통해
      end-to-end로 동작(mock 임베딩) · 사용자 보고

### Phase 2: 슬라이스 2 — memory.search

#### Task 7: memory.search E2E

**Description:** Zod 스키마(`{query: string, filter?: {tags?: string[]},
limit?: number}`) → query 임베딩 생성 → `vec_facts` KNN(top `max(limit*10,50)`
cap 전체 행 수) → tags ANY-match 후필터링(애플리케이션 레이어) → 상위 limit개
반환(코사인 거리 오름차순). limit 기본값 5 / 상한 20으로 Zod 스키마에 반영.

**Acceptance criteria:**
- [ ] 여러 fact 저장 후, 쿼리와 코사인 거리가 가장 가까운 순으로 반환됨
      (mock 임베딩으로 결정론적 벡터 사용해 순서 검증)
- [ ] `filter.tags` 지정 시 해당 태그를 하나도 안 가진 fact는 결과에서 제외
- [ ] limit 상한(20) 초과 요청 시 20으로 clamp
- [ ] Zod 검증 실패 케이스(query 누락 등)

**Verification:**
- [ ] `vitest run test/tools/search.test.ts`

**Dependencies:** T5, T6(저장된 fixture 필요) · **Files:**
memory/src/tools/search.ts, src/db/vector.ts, test/tools/search.test.ts ·
**Scope:** M

### Checkpoint C (슬라이스 2)
- [ ] 벡터 유사도 + 태그 필터 조합 검색이 end-to-end로 동작 · 사용자 보고

### Phase 3: 슬라이스 3 — memory.update

#### Task 8: memory.update E2E

**Description:** Zod 스키마(`{id: string, fact: {content?: string, tags?:
string[]}}`) — content가 제공되고 기존 값과 다를 때만 임베딩 재생성 후
vec_facts 갱신, tags만 바뀌면 임베딩 호출 자체를 하지 않음(spy로 호출 횟수
검증). `updated_at` 갱신.

**Acceptance criteria:**
- [ ] content 변경 시: 새 임베딩으로 vec_facts 갱신됨, 이후 search 결과가
      새 content 기준으로 바뀜
- [ ] tags만 변경 시: 임베딩 클라이언트 호출 0회(mock spy assertion)
- [ ] 존재하지 않는 id → 명시적 에러
- [ ] Zod 검증 실패 케이스

**Verification:**
- [ ] `vitest run test/tools/update.test.ts`(임베딩 mock에 call count
      assertion 포함)

**Dependencies:** T5, T6, T7 · **Files:** memory/src/tools/update.ts,
src/db/facts.ts(update), test/tools/update.test.ts · **Scope:** M

### Checkpoint D (슬라이스 3)
- [ ] content 변경 시에만 임베딩 재생성되는 동작이 검증됨(stale 임베딩 방지,
      SPEC §8 Always 충족) · 사용자 보고

### Phase 4: 슬라이스 4 — memory.similar

#### Task 9: memory.similar E2E

**Description:** Zod 스키마(`{id: string, limit?: number}`) — 대상 fact의
기존 임베딩을 vec_facts에서 재사용(재계산 없음)해 KNN 실행, 자기 자신 제외,
상위 limit개 반환.

**Acceptance criteria:**
- [ ] 자기 자신이 결과에 포함되지 않음
- [ ] 결과가 코사인 거리 오름차순
- [ ] 존재하지 않는 id → 명시적 에러
- [ ] Zod 검증 실패 케이스

**Verification:**
- [ ] `vitest run test/tools/similar.test.ts`

**Dependencies:** T6, T7(검색 쿼리 패턴 재사용) · **Files:**
memory/src/tools/similar.ts, src/db/vector.ts, test/tools/similar.test.ts ·
**Scope:** S

### Checkpoint E (슬라이스 4)
- [ ] similar가 자기 자신을 제외하고 정확히 동작 · 사용자 보고

### Phase 5: 슬라이스 5 — memory.delete

#### Task 10: memory.delete E2E

**Description:** Zod 스키마(`{id: string}`) — facts + vec_facts 양쪽에서
단일 id hard delete(트랜잭션). 전체 DB 삭제/초기화 경로 없음(SPEC §8 Never).

**Acceptance criteria:**
- [ ] 삭제 후 `memory.get`/`memory.search` 결과 어디에도 안 나타남
- [ ] facts, vec_facts 양쪽 행이 모두 사라짐(둘 중 하나만 남는 상태 없음)
- [ ] 존재하지 않는 id 삭제 시 명시적 에러(무음 성공 금지)
- [ ] Zod 검증 실패 케이스

**Verification:**
- [ ] `vitest run test/tools/delete.test.ts`

**Dependencies:** T6 · **Files:** memory/src/tools/delete.ts,
src/db/facts.ts(delete), test/tools/delete.test.ts · **Scope:** S

### Checkpoint F (tool 6종 완료)
- [ ] `npm test` 전체 green(search/get/save/update/similar/delete, 성공+
      Zod실패 케이스 전부) · CI 없이 GPU/모델 없이 통과 확인(SPEC §7 목표)
      · 사용자 보고

### Phase 6 (개정): Docker / s6 패키징 — 외부 OpenAI 호환 Embeddings API

#### Task 11: bitnet.cpp 사이드카 feasibility 스파이크 — 종료(방향 전환)

**결과 요약(실행 완료):** linux-test(aarch64)에서 bitnet.cpp를 실제로
빌드하고 `bitnet-embedding-0.6b.gguf`로 `llama-server --embedding` /
`llama-embedding` CLI 둘 다 구동 확인. HTTP 계약은 OpenAI 호환
`/v1/embeddings` 가정이 정확했음(T4 ASSUMPTION 확인됨). 하지만 **4토큰
이상의 다중 토큰 입력에서 임베딩 값이 전부 NaN**으로 확인됨. 원인 조사:
- `llama-eval-callback`으로 전체 27레이어 forward pass를 추적한 결과 NaN
  없음 → 문제는 embedding-전용 pooling 경로에 국한됨을 확인
- i2_s ARM 커널의 weight layout 버그 1건을 직접 특정(64/16 sequential vs
  실제 GGUF의 128/32 block layout 불일치) — 이는 커뮤니티 이슈
  [microsoft/BitNet#585](https://github.com/microsoft/BitNet/issues/585)와
  동일한 버그. 링크된 PR #586은 사용되지 않는 dead-code 파일을 패치하고
  있어서, 실제로 컴파일되는 `ggml-cpu/quants.c`의
  `ggml_vec_dot_i2_i8_s_1x1`에 동등한 fix를 직접 적용 → 재컴파일 후 출력값
  변화 확인(fix가 실제로 작동함을 확인)
- 그러나 fix 이후에도 **정확히 4토큰 이상에서 NaN 지속** — 별도의 두 번째
  버그. 4×4 GEMM 타일링 경계 가설을 세우고 검증했으나 기각(그 코드는
  `#if defined(__AVX2__)`에만 있어 ARM은 애초에 해당 경로를 타지 않음).
  GEMV/GEMM 호출부에 계측을 넣어 확인한 결과 추가 단서 없음
- 관련(하지만 동일하지 않은) 이슈 [microsoft/BitNet#517](https://github.com/microsoft/BitNet/issues/517)
  발견(다른 모델, `llama-server`의 batch/ubatch 크기 문제로 결론) — 우리
  증상과 정확히 일치하지 않음, GitHub 이슈 신규 제출은 보류

**결정(사용자 승인):** HA의 주력 실제 하드웨어(Raspberry Pi, HA Green/
Yellow)가 aarch64이고 두 번째 버그의 원인을 x86 비교 없이(이 환경엔 QEMU
에뮬레이션 없음) 특정하지 못한 상태이므로, 로컬 bitnet.cpp 추론 경로를
포기하고 **외부 OpenAI 호환 Embeddings API**로 전환. SPEC.md §2/§5/§8 갱신
완료(2026-07-31). `embedding/types.ts`의 `EmbeddingClient` 인터페이스와
`HttpEmbeddingClient`(재시도+backoff)는 이미 OpenAI 호환 계약을 가정하고
만들어져 있어 대부분 재사용 가능 — Authorization 헤더 추가만 필요(T11b).

**Dependencies:** None · **Files:** SPEC.md §2/§5/§8(완료) · **Scope:** L
(실행 완료, closed)

#### Task 11b: 임베딩 클라이언트에 외부 API 인증/설정 반영

**Description:** `src/embedding/client.ts`(`HttpEmbeddingClient`)에
`Authorization: Bearer {api_key}` 헤더 추가. `src/config.ts`의
`EMBEDDING_DIMENSIONS`(현재 bitnet 고정값 1024)를 설정 가능하게 변경
(기본값은 OpenAI `text-embedding-3-small`=1536). `EMBEDDING_BASE_URL` 기본값을
로컬 사이드카(`http://127.0.0.1:8100`)에서 외부 API 기본값(`https://api.openai.com`)
으로 변경. 새 `EMBEDDING_API_KEY`, `EMBEDDING_MODEL` 설정값 추가(요청 바디에
`model` 필드 포함하도록 `EmbeddingRequestBody` 확장). api_key 누락 시 명확한
에러(무음 실패 금지).

**Acceptance criteria:**
- [ ] `HttpEmbeddingClient`가 매 요청에 `Authorization: Bearer <key>` 헤더 전송
- [ ] `EMBEDDING_API_KEY` 미설정 시 즉시 명확한 에러(요청 자체를 보내지 않음)
- [ ] 요청 바디에 `model` 필드 포함(설정된 값)
- [ ] `EMBEDDING_DIMENSIONS`가 상수가 아닌 설정값으로 DB 스키마 초기화에 사용됨

**Verification:**
- [ ] `vitest run test/embedding/client.test.ts` — mock 서버에서 Authorization
      헤더 존재·값 검증 테스트 추가, api_key 누락 케이스 테스트 추가

**Dependencies:** T11(결정) · **Files:** memory/src/embedding/client.ts,
memory/src/embedding/types.ts, memory/src/config.ts,
memory/test/embedding/client.test.ts · **Scope:** S

#### Task 12: Dockerfile + mcp-server 단일 s6 서비스

**Description:** 단일 스테이지 Dockerfile(`ARG BUILD_FROM`, HA 표준 base
이미지 — 사이드카가 없으므로 T11의 glibc/musl 결정 불필요, better-sqlite3/
sqlite-vec 네이티브 모듈 호환성만 고려하면 됨). Node 앱 빌드 스텝
(`COPY package*.json .`, `npm ci`, `COPY src tsconfig.json .`,
`npm run build`, `npm prune --omit=dev`). `rootfs/etc/s6-overlay/s6-rc.d/
mcp-server/{run,finish,type,dependencies.d/base}` — 서비스 1개뿐이므로
readiness 폴링 로직 불필요(외부 API는 항상 "떠있다"고 가정, 요청 시점
재시도가 일시 장애를 흡수). `run`은 `discovery: [mcp]` announce
(`bashio::discovery`, ha-app-crw의 `mcp-bridge/run` 패턴) 후 `exec node
dist/index.js`. `finish`는 ha-app-crw 패턴 재사용(exitcode≠0,256 → halt).
`config.yaml` 작성 — `discovery: [mcp]`, `ports: {8099/tcp: null}`,
`init: false`, `startup: services`, **새로운 `options`/`schema` 블록**
(`api_key: password`, `base_url: str?`, `model: str?`,
`embedding_dimensions: int?`).

**Acceptance criteria:**
- [ ] linux-test에서 amd64·aarch64 둘 다 `docker build` 성공
- [ ] `config.yaml`의 `api_key`가 `password` 타입(로그/UI에 마스킹됨)
- [ ] 컨테이너 기동 후 `/mcp`에 `tools/list` 호출 시 6개 tool 전부 노출
- [ ] `api_key` 미설정 상태로 `memory.save` 호출 시 명확한 MCP 에러(컨테이너
      크래시 아님)

**Verification:**
- [ ] `hadolint memory/Dockerfile`
- [ ] `shellcheck memory/rootfs/etc/s6-overlay/s6-rc.d/mcp-server/run`
- [ ] `yamllint memory/config.yaml`
- [ ] linux-test: `docker build --platform linux/amd64,linux/arm64 ...` 성공,
      컨테이너 기동 후 `curl -X POST http://127.0.0.1:8099/mcp` initialize +
      tools/list 확인

**Dependencies:** T11b · **Files:** memory/Dockerfile, memory/config.yaml,
memory/rootfs/etc/s6-overlay/s6-rc.d/mcp-server/*,
memory/rootfs/etc/s6-overlay/s6-rc.d/user/contents.d/mcp-server · **Scope:** M

#### Task 13: 풀 컨테이너 라운드트립 (실제 외부 API)

**Description:** 실제 embedding API key(사용자 제공, 테스트용)로 컨테이너를
기동해 `memory.save` → `memory.search`가 mock이 아닌 **실제 외부 API**를
거쳐 end-to-end로 동작하는지 확인. 외부 API 호출 실패(네트워크 문제, 잘못된
키, rate limit) 시 mcp-server가 명확한 에러를 반환하고 컨테이너가 죽지
않는지 확인(요청-시점 재시도가 T11b에서 이미 구현됨).

**Acceptance criteria:**
- [ ] `memory.save` → `memory.search`가 실제 외부 API 임베딩으로 동작(첫 실
      API 검증)
- [ ] 잘못된 api_key로 호출 시 명확한 MCP 에러(401 등 그대로 노출 또는 래핑)
- [ ] 네트워크 차단 상태 시뮬레이션 시 재시도 후 명확한 타임아웃 에러

**Verification:**
- [ ] linux-test: `docker run` 후 `curl -X POST http://127.0.0.1:8099/mcp`로
      initialize + tools/call(save) + tools/call(search) 시퀀스 확인
- [ ] `docker run`에서 `api_key`를 의도적으로 잘못 설정해 에러 경로 확인

**Dependencies:** T12, T5–T10(전체 tool) · **Files:** 없음(런타임 검증만) ·
**Scope:** S

### Checkpoint G (Phase 6 완료)
- [ ] linux-test에서 2아치 빌드 green, 실제 외부 API로 save→search
      end-to-end 동작, api_key 누락/오류 시 명확한 에러(무음 실패 아님) ·
      사용자 보고

### Phase 7: End-to-end HA 통합 검증

#### Task 14: HA Supervisor discovery + Assist 대화 스모크 테스트

**Description:** 실 HA 인스턴스(또는 테스트 인스턴스)에 addon 설치, Supervisor
discovery announce가 core `mcp` integration에 실제로 수신되는지 확인
(**주의**: ha-app-crw의 `mcp-bridge/run` 주석에 기록된 대로, 이 계획 작성
시점 기준 core `mcp` integration에 hassio discovery 수신부가 없었을 수 있음
— 현재 core 버전에서 재확인 필요, 없으면 URL 수동 등록 절차를 DOCS에 남기고
이 태스크는 "수동 등록으로 검증됨"을 성공 기준으로 완화). Assist 대화로
"기억해줘"류 발화 → `memory.save` 호출 확인 → 이후 대화에서 관련 질문 →
`memory.search` 경유 응답 확인.

**Acceptance criteria:**
- [ ] addon이 HA Supervisor에서 정상 기동(로그에 에러 없음)
- [ ] MCP 엔드포인트가 core `mcp` integration에(자동 discovery 또는 수동
      등록으로) 연결됨
- [ ] Assist 대화 1회 이상에서 fact 저장 → 별도 대화 턴에서 의미 기반 검색으로
      재활용되는 것을 실기기에서 확인
- [ ] 이 시점의 core discovery 지원 여부가 확인되어 SPEC.md/DOCS에 기록됨

**Verification:**
- [ ] HA UI: Settings → Devices & Services → MCP integration에 endpoint 노출
      확인(자동이든 수동이든)
- [ ] Assist 대화 로그(또는 conversation trace)에서 tool 호출 2회(save, search)
      확인

**Dependencies:** T13 · **Files:** memory/DOCS.md(수동 등록 절차 문서화 시) ·
**Scope:** S

### Checkpoint H (완료)
- [ ] SPEC.md의 핵심 가치("LLM이 대화에서 얻은 사실을 지속 기억하고 의미
      기반으로 재활용")가 실기기에서 입증됨 · 사용자 보고

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 외부 embedding API 장애/rate limit이 save/search를 직접 실패시킴 | High | 요청-시점 재시도+backoff(T4, 이미 구현됨)로 일시 장애 흡수, 상한 초과 시 명확한 MCP 에러(무음 실패 금지) |
| api_key가 로그/에러 메시지에 노출됨 | High | `password` 스키마 타입(T12), 로그 함수는 길이/개수만 기록(SPEC §8 Always, T5부터 이미 준수) — T11b에서 재확인 |
| provider별 임베딩 차원이 달라 기존 벡터와 호환이 깨짐(모델/provider 교체 시) | Med | `embedding_dimensions`를 설정값으로 노출(T12), 교체는 SPEC §8 Ask-First 항목으로 명시 |
| better-sqlite3 / sqlite-vec npm 패키지의 prebuilt 바이너리가 target base 이미지와 musl 미호환 | Med | 사이드카 제거로 base 이미지 선택 폭이 넓어짐(bitnet.cpp glibc 제약 사라짐); T12에서 실제 `npm ci` 시점에 확인, 필요 시 소스 컴파일 fallback |
| core `mcp` integration이 Supervisor discovery 수신부 미구현(ha-app-crw에 기록된 알려진 gap) | Med | T14에서 재확인, 미구현이면 수동 URL 등록으로 완화하고 DOCS.md에 절차 기록 — announce 자체는 무해하므로 선제 구현 유지 |
| 외부 API로의 아웃바운드 네트워크 요청이 fact 원문을 제3자 서비스로 전송(로컬 전용에서 벗어남) | Med | SPEC에 이미 반영된 트레이드오프(사용자 결정). provider 선택은 사용자 재량(`base_url` 설정 가능), 문서에 명시 필요(T14/DOCS) |
| sqlite-vec KNN + tags 필터 합성이 대규모 fact에서 비효율(top-K 후필터링 방식) | Low | 개인용 규모(수백~수천 fact)에서는 무관. 대규모화 시 별도 태스크로 재설계(Open Questions) |

## Open Questions

- bitnet.cpp ARM 다중 토큰 NaN 버그(4토큰 이상)의 정확한 원인은 미해결 —
  GitHub 이슈 미제출 상태(T11 참조). 추후 로컬 추론으로 재전환하고 싶다면
  별도 요청으로 이슈 제출 + 원인 규명 재개 가능
- 기본 embedding provider/model/dimensions(OpenAI `text-embedding-3-small`,
  1536차원)은 T11b에서 기본값으로 확정 예정 — 사용자가 다른 provider를
  원하면 `config.yaml` `options`로 재정의 가능하도록 설계
- tags 필터 매칭 시맨틱을 ANY-match로 기본 설계했음 — ALL-match가 필요하면
  T7에서 조정(SPEC이 명시하지 않음)
- `memory.search`의 limit 기본값(5)/상한(20)은 T7에서 최종 확정
- core `mcp` integration의 Supervisor discovery(hassio 수신부) 지원 여부는
  현재 HA core 버전에서 재확인 필요(ha-app-crw 작성 시점엔 미구현)
- ha-apps 카탈로그 등록(GitHub repo/CI/release-drafter 워크플로)은 이 계획
  범위 밖 — SPEC.md에 명시된 요구사항이 아니므로 포함하지 않음. 필요하면 별도
  요청으로 Phase 8 추가 가능(ha-app-crw의 CI·문서·릴리스 패턴 재사용)

## Parallelization

- **T11(bitnet.cpp 스파이크)은 Node 코드에 의존하지 않으므로 Phase 0 직후
  즉시 시작해 Phase 1~5와 완전 병렬 진행 권장** — 가장 리스크가 크고
  불확실성이 높은 태스크이므로 최대한 일찍 착수해 Phase 6 일정을 선점적으로
  de-risk
- T3(DB 기반)과 T4(임베딩 클라이언트 기반)는 서로 독립적이라 병렬 가능
- T9(similar)와 T10(delete)은 서로 독립적이라 병렬 가능(둘 다 T6 이후)
