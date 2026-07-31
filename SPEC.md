# SPEC.md — ha-app-memory

## 1. Objective

Home Assistant 애드온 형태로 동작하는 개인용 메모리(기억) 시스템. HA Assist의 대화형 LLM이
MCP(Model Context Protocol) Tool을 통해 사실(fact)을 저장/검색/조회/수정/삭제할 수 있게 한다.
검색은 임베딩 기반 벡터 유사도(semantic search)로 수행하며, 메타데이터 필터를 함께 지원한다.

**대상 사용자**: HA Assist에 연결된 conversation LLM (내부 클라이언트). 애드온은 HA Supervisor의
`discovery: [mcp]` 메커니즘으로만 노출되며 (내부 전용 포트, 호스트에 게시하지 않음), 외부
네트워크에서는 접근할 수 없다.

**핵심 가치**: LLM이 사용자와의 대화에서 얻은 사실을 지속적으로 기억하고, 이후 대화에서
의미 기반으로 관련 기억을 찾아 활용할 수 있게 한다.

## 2. Tech Stack

| 영역 | 선택 |
|---|---|
| 런타임 | Node.js (LTS) + TypeScript (strict) |
| MCP | `@modelcontextprotocol/sdk` (TypeScript), Streamable HTTP transport |
| Embedding | upstream `llama.cpp`(`llama-server`) 로컬 사이드카 + `Qwen3-Embedding-0.6B` (OpenAI 호환 `POST /v1/embeddings`) |
| Vector DB | SQLite + `sqlite-vec` 확장 |
| Search | Cosine similarity (sqlite-vec) + metadata filter (SQL WHERE) |
| Packaging | HA Add-on (Docker, s6-overlay) |
| Validation | Zod (MCP tool 입력 스키마) |
| Test | Vitest |

### Embedding 연동 방식 (최종: upstream llama.cpp 로컬 사이드카)

**변경 이력 (2회 전환)**

1. **로컬 `bitnet.cpp` + `bitnet-embedding-0.6b` (기각)** — feasibility spike(Task 11)에서
   해당 모델의 i2_s 커널이 aarch64에서 다중 토큰(4개 이상) 입력 시 NaN을 반환하는 것을 확인.
   레이아웃 버그 1건(microsoft/BitNet#585)은 직접 특정·수정했으나 별도 버그가 남았다.
2. **외부 OpenAI 호환 API (중간 단계, 기각)** — 인터넷/API 키 의존이 개인용 로컬 메모리
   시스템의 취지와 맞지 않아, BitNet 재검토(Task 11c) 결과를 근거로 로컬 경로로 복귀.

**최종 결정 근거 (Task 11c 조사)**

- `microsoft/BitNet`은 유지보수가 사실상 정체 상태다: 오픈 이슈 304건 / 오픈 PR 110건,
  ARM 수정 PR(#469, #551, #580, #586)은 전부 리뷰·병합 0건, 2026-03 이후 병합된 것은
  유지보수자 본인의 문서/릴리스뿐. ARM i2_s는 2026-01-27 병합된 회귀 이후 계속 깨진 상태다.
- PR #551/#586이 고치는 `src/ggml-bitnet-mad.cpp`는 **애초에 빌드에 포함되지 않는다**.
  `src/CMakeLists.txt`가 `set(GGML_SOURCES_BITNET ...)`를 append 없이 두 번 호출해 덮어쓰고,
  그 변수는 repo 어디에서도 참조되지 않는다. (linux-test 실측 결과와도 일치)
- `bitnet-embedding-0.6b`의 공식 I2_S 가이드에는 ARM/NEON/aarch64 언급이 **0건**이며
  빌드 플래그·벤치마크가 전부 x86(Xeon) 전용이다. 즉 ARM은 검증된 적이 없다.
- upstream `ggml-org/llama.cpp`로 그 모델을 돌리려면 새 아키텍처 이식이 필요하다. GGUF는
  `general.architecture=qwen3`이지만 블록당 텐서가 18개로, 표준 qwen3(11개)에 없는
  per-projection 입력 RMSNorm 7개(`attn_{q,k,v,output}_norm_in`, `ffn_{gate,up,down}_norm_in`)가
  추가된 BitNet subln 변형이다. upstream에는 `*_norm_in` 텐서명 자체가 존재하지 않는다.

**채택안**: upstream `llama.cpp`의 `llama-server`를 컨테이너 내 사이드카로 띄우고,
upstream이 네이티브로 지원하는 `Qwen/Qwen3-Embedding-0.6B-GGUF`(Apache-2.0, Q8_0 약 609 MiB)를
사용한다. 이 모델은 텐서 310개(=28×11+2)로 표준 qwen3 그대로이며, `embedding_length=1024`,
`pooling_type=3(LAST)`가 GGUF에 내장되어 있어 별도 플래그가 필요 없다.

`llama-server`는 OpenAI 호환 `POST /v1/embeddings`를 그대로 제공하므로 기존
`EmbeddingClient` / `HttpEmbeddingClient`(재시도+backoff)는 **코드 변경 없이 재사용**한다.
`base_url`만 사이드카(`http://127.0.0.1:8080`)를 가리키면 된다. 로컬 사이드카는 인증이
없으므로 `api_key`는 **선택 값**으로 바꾸고, 설정된 경우에만 `Authorization: Bearer` 헤더를
붙인다(외부 API를 쓰고 싶은 사용자를 위한 탈출구 유지).

사이드카가 다시 생기므로 s6 서비스는 `llama-server`와 `mcp-server` 2개이며, `mcp-server`는
기동 시 사이드카 health를 유한 횟수 폴링한 뒤 시작한다.

**임베딩 차원은 1024로 고정**한다(모델 네이티브). 기존 코드의 기본값 1536에서 변경.

## 3. MCP Tools (Interface)

모두 Zod 스키마로 입력을 검증한다.

- `search(query: string, filter?: object, limit?: number)` → 코사인 유사도 상위 N개 + 메타데이터 필터
- `get(id: string)` → 단일 fact 조회
- `save(fact: { content: string, tags?: string[] })` → 임베딩 생성 후 저장, id 반환
- `update(id: string, fact: { content?: string, tags?: string[] })` → content 변경 시 임베딩 재생성
- `similar(id: string, limit?: number)` → 특정 fact와 유사한 다른 fact 목록
- `delete(id: string)` → hard delete

### 데이터 모델 (최소 스키마)

```
facts (
  id          TEXT PRIMARY KEY,   -- uuid
  content     TEXT NOT NULL,
  tags        TEXT,               -- JSON array
  embedding   FLOAT[N],           -- sqlite-vec virtual table
  created_at  TEXT NOT NULL,      -- ISO8601
  updated_at  TEXT NOT NULL
)

meta (                            -- 사용자 승인 후 추가 (SPEC §8 Ask First)
  key   TEXT PRIMARY KEY,         -- 'embedding_model'
  value TEXT NOT NULL             -- 벡터를 쓴 모델 식별자(model_file)
)
```

`vec_facts`의 DDL은 벡터의 **폭**은 알지만 **의미**는 모른다. 같은 폭의 다른 모델로 바꾸면
insert/search가 정상 동작하면서 기존 기억만 조용히 안 잡힌다. 이를 탐지할 근거가 달리
없으므로 `meta`에 모델 식별자를 기록한다.

메타데이터 필터는 `tags`에 대해서만 지원한다 (필요 시 이후 확장).

## 4. Commands

| 목적 | 명령 |
|---|---|
| 의존성 설치 | `npm install` |
| 개발 실행 (임베딩은 `EMBEDDING_BASE_URL`이 가리키는 llama-server 필요) | `npm run dev` |
| 빌드 | `npm run build` |
| 타입체크 | `npm run typecheck` |
| 린트 | `npm run lint` |
| 테스트 | `npm test` |
| 애드온 이미지 빌드 (로컬 검증) | `docker build -t ha-app-memory .` — 반드시 CLAUDE.md의 `linux-test` 컨테이너 머신에서 실행 |

## 5. Project Structure

Repo 루트는 문서/tasks만 가지고, 실제 애드온은 `memory/` 서브디렉토리에 둔다
(향후 여러 애드온을 한 repo나 HA add-on 카탈로그로 묶기 쉬운 구조).

```
ha-app-memory/
├── SPEC.md
├── tasks/
│   ├── plan.md
│   └── todo.md
├── .agents/memory/MEMORY.md
└── memory/                          # 실제 HA add-on
    ├── config.yaml                  # discovery: [mcp], 내부 전용 포트, 외부 미노출
                                      # + options/schema (model/threads, 선택적 base_url/api_key)
    ├── Dockerfile                   # upstream llama.cpp 빌드 + Node 빌드 (멀티스테이지)
    ├── package.json, tsconfig.json, vitest.config.ts, eslint 설정
    ├── rootfs/etc/s6-overlay/s6-rc.d/
    │   ├── model-download/{up,up.sh,type,dependencies.d/base}          # oneshot: 모델 준비
    │   ├── llama-server/{run,finish,type,dependencies.d/{base,model-download}}
    │   ├── db-migrate/{up,up.sh,type,dependencies.d/{base,llama-server}}   # oneshot: 재임베딩
    │   ├── mcp-server/{run,finish,type,dependencies.d/{base,llama-server,db-migrate}}
    │   ├── discovery/{run,up,type,dependencies.d/mcp-server}            # oneshot: MCP announce
    │   └── user/contents.d/{model-download,llama-server,db-migrate,mcp-server,discovery}
    ├── src/
    │   ├── index.ts, log.ts, config.ts
    │   ├── tools/                   # search/get/save/update/similar/delete 구현
    │   ├── db/                      # sqlite-vec 스키마, 쿼리
    │   └── embedding/               # OpenAI 호환 Embeddings HTTP 클라이언트 (사이드카 대상)
    └── test/                        # src/ 구조 미러
```

## 6. Code Style

- TypeScript strict 모드, `any` 금지 (부득이한 경우 주석으로 이유 명시).
- 모든 MCP tool 입력은 Zod 스키마로 파싱 후 사용.
- async/await만 사용 (콜백/`.then` 체인 금지).
- 파일당 단일 책임: tool 정의, DB 접근, 임베딩 클라이언트를 분리.
- 포맷터/린터는 ESLint + Prettier 기본 설정을 따르고 커스텀 규칙은 최소화.

## 7. Testing Strategy

- **단위 테스트**: DB 레이어(schema, CRUD, vector search 쿼리)는 임시 sqlite 파일 + sqlite-vec로 실제 실행.
- **임베딩 클라이언트**: 외부 API를 목(mock) HTTP 서버로 대체해 계약(요청/응답 포맷, 인증 헤더)만
  검증. 실제 외부 API 호출은 CI에서 요구하지 않는다(비용·네트워크 의존성 회피).
- **MCP tool 테스트**: 각 tool 핸들러에 대해 정상 케이스 + 잘못된 입력(Zod 검증 실패) 케이스.
- 목표: `npm test`가 CI에서 별도 GPU/모델 없이 통과해야 한다.

## 8. Boundaries

**항상 (Always)**
- 모든 MCP tool 입력은 저장/조회 전에 Zod로 검증한다.
- 애드온은 HA Supervisor discovery(`discovery: [mcp]`)로만 노출한다 (`config.yaml`에서
  포트는 내부 전용으로 선언하고 host에 게시하지 않는다).
- save/update 시 content 임베딩을 새로 생성해 저장한다 (stale 임베딩 방지).
- tool 호출과 결과는 로그로 남긴다 (내용 자체는 민감할 수 있으므로 길이/개수 정도만 로깅, 원문 로깅 금지).
- 임베딩 사이드카(`llama-server`)는 TCP 포트가 아니라 **unix domain socket**
  (`/run/llama/embed.sock`, 디렉토리 0700 root)에 바인딩한다. 노출 가능한 주소 자체가
  없으므로 "외부 미노출"이 설정 규약이 아니라 구조로 보장된다.
- `api_key`는 선택 값이지만, 설정된 경우 `config.yaml`의 `schema`에서 `password` 타입으로
  선언하고 로그에 절대 남기지 않는다.
- GGUF 모델은 `/data`에 받아 애드온 업데이트 간 유지한다. `model_sha256`이 설정되어 있으면
  다운로드 후 검증하고 불일치 시 기동을 중단한다. 미설정이면 검증을 건너뛰되 경고와 함께
  실제 해시를 출력해 사용자가 고정할 수 있게 한다(모델 교체 시 해시부터 찾아야 하는 마찰 제거).
- 모델 다운로드/검증은 longrun이 아니라 **oneshot(`model-download`)** 으로 수행한다. longrun은
  실패 시 s6가 즉시 재시작하므로, 설정 오류(잘못된 repo/파일/체크섬) 하나로 수백 MB를 무한
  재다운로드하게 된다. oneshot은 재시도되지 않으며 `S6_BEHAVIOUR_IF_STAGE2_FAILS=2`와 함께
  에러를 남긴 채 애드온을 정지시킨다.
- 모델이나 벡터 폭이 바뀌면 **`db-migrate` oneshot이 저장된 모든 fact의 content로 재임베딩**한다
  (mcp-server보다 먼저, llama-server 준비 후 실행). 임베딩을 전부 계산한 **뒤에** 한 트랜잭션으로
  기록하므로, 도중 실패해도 DB는 변경 전 상태 그대로이며 반쯤 마이그레이션된 상태가 없다.
- `openDb()`는 여전히 불일치를 거부한다(마이그레이션을 우회한 경우의 안전망). 마이그레이션만
  `unchecked` 옵션으로 이 가드를 건너뛴다.
- `meta` 행이 없는 구버전 DB는 **모델을 추측하지 않고 재임베딩**한다. 현재 모델이라고 가정하면
  조용히 깨진 기억이 남을 수 있다. vec0의 `CREATE VIRTUAL TABLE IF NOT EXISTS`는 기존 폭을 조용히 유지하므로,
  방치하면 기동은 성공하고 이후 모든 save/search가 런타임에 실패한다.

**먼저 확인 (Ask First)**
- `facts` 테이블 스키마 변경이나 마이그레이션이 필요한 변경.
- `config.yaml`의 네트워크/포트/discovery 설정 변경.
- 새로운 네이티브 의존성(예: 다른 sqlite 확장, 별도 바이너리) 추가.
- 임베딩 provider/model 교체 또는 임베딩 차원 변경 (기존 벡터와 호환 깨짐).

**절대 금지 (Never)**
- Supervisor discovery 외 경로로 포트를 외부에 노출하지 않는다 (host 포트 게시 금지).
- MCP tool 입력을 SQL에 문자열 결합으로 삽입하지 않는다 (항상 파라미터 바인딩).
- 사용자 확인 없이 DB 파일 전체를 삭제/초기화하지 않는다 (`delete`는 단일 id만 대상).
- `api_key`를 코드, 커밋, 로그에 하드코딩/노출하지 않는다 (add-on `options`로만 주입).
- `llama-server`를 TCP 포트(`--port`/`--host <ip>`)에 바인딩하지 않는다 (unix socket 전용).
- SQLite를 별도 서버 프로세스로 분리하지 않는다. 현재 DB는 우리 프로세스만 여는 `/data`의
  파일이라 네트워크 표면이 0이며, 서버로 분리하면 없던 리스닝 소켓이 생겨 표면이 늘어난다.
  `sqlite-vec`도 인프로세스 로더블 확장이 전제다.
