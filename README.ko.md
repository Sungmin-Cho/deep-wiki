[English](./README.md) | **한국어**

# deep-wiki

![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/deep-wiki?label=version)
![license](https://img.shields.io/github/license/Sungmin-Cho/deep-wiki)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/deep-suite)

LLM이 관리하는 마크다운 위키 — [Karpathy의 LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 철학을 Claude Code와 Codex에서 구현한 플러그인입니다.

> *"대부분의 사람들이 LLM과 문서를 사용하는 방식은 RAG입니다. 파일 모음을 업로드하면 LLM이 쿼리 시점에 관련 청크를 검색하고 답변을 생성합니다. 이건 작동하지만, LLM은 매번 질문할 때마다 지식을 처음부터 재발견하고 있습니다. 축적이 없습니다."*
> — Andrej Karpathy

매번 지식을 재발견하는 RAG 대신, deep-wiki는 **점진적으로 영구 위키를 구축하고 유지**합니다 — 구조화되고 상호 연결된 마크다운 파일 모음입니다. 새 소스를 추가하면 LLM이 읽고, 핵심 정보를 추출하고, 기존 위키에 통합합니다. 상호 참조는 이미 거기 있고, 모순은 이미 표시되어 있으며, 종합은 이미 읽은 모든 내용을 반영합니다. 지식은 한 번 컴파일되고 최신 상태로 유지되며, 매 쿼리마다 다시 도출되지 않습니다.

## deep-suite에서의 역할

deep-wiki는 [deep-suite](https://github.com/Sungmin-Cho/deep-suite)의 **지속적 지식 레이어**입니다. [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) 2×2 매트릭스에서 **Inferential Guide**로 동작 — 에이전트의 이해를 형성하는 축적된 프로젝트 지식을 제공하며, 반복적인 RAG 쿼리를 복리로 쌓이는 지식 베이스로 대체합니다. 5개의 `/wiki-*` 진입점은 스킬이므로 Claude Code(슬래시 커맨드)에서, 그리고 Codex / Copilot CLI / Gemini CLI / Agent SDK에서 `Skill({ skill: "deep-wiki:wiki-<verb>" })` 형태로 네이티브로 실행됩니다.

## 아키텍처

Karpathy의 3계층 모델 기반:

```
Raw Sources  →  Wiki (markdown pages)  →  Schema (management rules)
    ↑                   ↑                        ↑
 wiki-ingest        pages/               wiki-schema skill
```

| 계층 | 설명 | 소유자 |
|-------|-------------|-------|
| **Raw Sources** | 불변 입력 — 파일, URL, 텍스트, 리포트 | 사용자가 큐레이션 |
| **Wiki** | 상호 참조가 있는 LLM 생성 마크다운 페이지 | LLM이 작성, 사용자가 읽음 |
| **Schema** | 위키 구조화·유지 방식을 규정하는 규칙 | 함께 진화 |

## 설치

### deep-suite 마켓플레이스 경유 (권장)

```bash
# Claude Code
/plugin marketplace add Sungmin-Cho/deep-suite
/plugin install deep-wiki@claude-deep-suite

# Codex
codex plugin install deep-wiki
```

### 단독 설치

```bash
/plugin marketplace add Sungmin-Cho/deep-wiki
/plugin install deep-wiki@Sungmin-Cho-deep-wiki
```

전제 조건: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI(또는 Codex)가 설치·구성되어 있어야 합니다.

## 빠른 시작

```bash
# 1. 위키 초기화
/wiki-setup ~/Obsidian/MyVault/wiki

# 2. 소스를 위키로 ingest
/wiki-ingest https://example.com/article
/wiki-ingest ./document.pdf
/wiki-ingest                       # 텍스트를 직접 붙여넣기

# 3. 위키 질의
/wiki-query React hooks의 규칙이 뭐야?

# 4. 헬스 체크
/wiki-lint
```

## 커맨드

| 커맨드 | 설명 |
|---------|-------------|
| `/wiki-setup` | 위키 초기화 및 디렉토리 구조 생성 |
| `/wiki-ingest` | 소스(URL, 파일, 텍스트, deep-work 리포트)를 읽어 위키 페이지 생성/갱신 |
| `/wiki-query` | 위키 검색 후 근거 기반 답변 생성; 페이지 간 종합은 위키에 자동 파일링 |
| `/wiki-lint` | 헬스 체크 — 스키마 위반, orphan 페이지, broken link, 모순 (ingest/rebuild 후 자동 실행) |
| `/wiki-rebuild` | 페이지 frontmatter로부터 machine-readable 인덱스 재생성 |

### 동작 상세

**Ingest** — 새 소스를 넣으면 LLM이 읽고, 요약 페이지를 작성하고, 인덱스를 갱신하고, 위키 전반의 관련 페이지를 갱신하고, 로그에 추가합니다. 하나의 소스가 여러 페이지를 건드릴 수 있습니다. 새 정보는 기존 내용과 병합되어 페이지가 ingest마다 풍부해집니다. **ingest 후 auto-lint가 실행됩니다.**

**Query** — 위키에 질문합니다. LLM이 3계층 전략(인덱스 스캔 → 콘텐츠 검색 → 후보 읽기)으로 관련 페이지를 찾아 인용과 함께 근거 기반 답변을 종합합니다. **하나의 쿼리가 2개 이상 페이지에 걸친 인사이트를 종합하면 그 결과가 위키에 자동 파일링됩니다** — 지식이 복리로 쌓입니다.

**Lint** — 위키 헬스 체크: 스키마 위반, 페이지 간 모순, orphan 페이지, broken link, stale 버전, 인덱스 drift. `--fix`로 구조적 문제를 자동 복구합니다. **ingest와 rebuild 후 자동 실행** — 깊은 점검 시에만 수동 호출하면 됩니다.

**Rebuild** — 페이지 frontmatter로부터 `index.json`을 재생성합니다. 인덱스가 동기화에서 벗어났거나 손상되었을 때 사용합니다. 이후 auto-lint가 실행됩니다.

## 저장 구조

```
<wiki_root>/
├── index.md                  # LLM이 작성하는 dashboard (사람이 읽음)
├── log.md                    # LLM이 작성하는 chronicle (사람이 읽음)
├── log.jsonl                 # Append-only 구조화 이벤트 로그
├── pages/                    # 위키 페이지 (flat, 태그 기반 분류)
└── .wiki-meta/
    ├── .config.json          # Wiki-local auto-ingest 및 A5 knob config
    ├── index.json            # Machine-readable 페이지 catalog (파생; M3 envelope-wrapped)
    ├── sources/              # 소스별 provenance YAML 파일
    └── .versions/            # 덮어쓰기 전 페이지 백업 (최근 3개)
```

핵심 설계 결정:
- **Flat `pages/` 디렉토리** — 하위 디렉토리 없음. 태그가 카테고리를 대체 (더 유연하고 이동으로 인한 broken link 없음).
- **Dual artifacts** — `index.md`/`log.md`는 사람을 위해 LLM이 작성; `index.json`/`log.jsonl`은 machine-readable 대응물.
- **`.wiki-meta/`는 숨김** — Obsidian의 그래프 뷰와 파일 탐색기에서 보이지 않음.

## 설정

`~/.claude/deep-wiki-config.yaml`:

```yaml
wiki_root: ~/Obsidian/MyVault/wiki

# Obsidian CLI가 있으면 /wiki-setup이 자동 감지 (선택)
obsidian_cli:
  available: true
  vault_name: "My Vault"
  vault_path: ~/Obsidian/MyVault
  wiki_prefix: "wiki"
```

### Auto-ingest 범위 (`auto_ingest`)

SessionStart hook은 스캔 대상을 필터링하는 선택적 `auto_ingest` 블록을 세 가지 YAML 형식으로 받습니다 (모두 동일; block 형식과 dotted 형식이 함께 있으면 항목이 union됩니다):

```yaml
# Block 형식
auto_ingest:
  ignore_globs:
    - "**/archive-*.md"
    - "**/draft-*.md"
  require_tag: project        # frontmatter에 이 태그가 있는 파일만 ingest

# Inline 형식
auto_ingest:
  ignore_globs: ["**/archive-*.md", "**/draft-*.md"]

# Dotted 형식
auto_ingest.ignore_globs: ["**/archive-*.md"]
```

위 YAML 예시는 bootstrap/legacy alias 형식입니다. 소유권을 가진 wiki-local 파일은 `<wiki_root>/.wiki-meta/.config.json`이며 JSON을 사용합니다:

```json
{
  "auto_ingest": {
    "ignore_globs": ["archive/**"],
    "require_tag": "project"
  }
}
```

프로덕션 ownership: wiki-local `.wiki-meta/.config.json`가 `auto_ingest`를 소유합니다. 허용되는 wiki-local key는 `auto_ingest`, `a5_fanout_threshold`, `a5_worker_timeout_sec`입니다. migration은 A5 key를 보존하면서 `auto_ingest` ownership만 이동합니다. A5 key는 기존 파일이 계속 유효하도록 남겨 둔 것이며, `/wiki-ingest`는 모든 host에서 main caller로 실행되어 둘 다 읽지 않습니다. `ignore_globs`의 ignore glob은 vault-relative이므로 `notes/private/**`는 wiki metadata directory가 아니라 vault root 기준으로 매칭됩니다.

global host YAML `auto_ingest`는 bootstrap/legacy alias일 뿐이며, `/wiki-setup`과 SessionStart가 동등한 legacy policy를 스캔 전에 wiki-local 파일로 migration합니다. 유지된 global alias는 제거 전까지 계속 resolve됩니다. legacy YAML은 `policy_source=wiki_local_migrated` 이후에만 제거하고, 다시 resolve해 `policy_source=wiki_local` 확인 후 local owner만 신뢰하세요. 충돌하는 local 및 legacy policy는 fail closed합니다. `CONFIG_CONFLICT` recovery for local-vs-legacy policy values는 local과 legacy 값을 일치시키거나 policy block 하나를 삭제하는 것입니다. 이 작업은 모든 host를 중지한 상태에서 수행하세요. `CONFIG_CONFLICT candidates=...`는 cross-host candidate YAML file divergence를 뜻하므로, 이름이 보고된 host YAML 파일들을 모든 host가 중지된 상태에서 reconcile하세요. 대표 invalid local config shape, including non-regular file, symlink, duplicate key, invalid UTF-8, 또는 >64 KiB는 `CONFIG_INVALID`로 fail closed하며, 다른 malformed 또는 unsupported wiki-local key도 fail closed합니다.

두 파일을 직접 편집 전에는 모든 host를 중지하고 backup을 만든 뒤, 한 host만 다시 시작해 runtime revalidation을 통과시키세요. `--replace-config`는 invalid selected-host YAML을 우회하지 않습니다. 해당 selected host file을 stopped-host 규칙 아래에서 먼저 고치거나 제거한 뒤 replace해야 합니다. 서로 다른 `CODEX_HOME` 또는 `HOME` 값은 별도 setup-authority domain을 만들므로, 같은 wiki를 공유할 때는 하나의 physical home을 사용하세요. `.deep-wiki-setup-authority.json`와 `.deep-wiki-setup.reserve`는 home authority artifact이며 SessionStart config candidate가 아닙니다. authority가 소유한 wiki를 이동하려면 명시적 stopped-host rebind가 필요하며, rebind resume에는 원래 `CODEX_HOME` 및 `DEEP_WIKI_CONFIG` spelling이 필요합니다. Rollback은 계속 백업 전용 downgrade이며, 구버전의 in-place mutation이 아닙니다.

### 클라우드 백업 `wiki_root` (iCloud / Google Drive / Dropbox)

Obsidian vault가 sync-daemon이 마운트한 경로에 있으면 위키 write마다 sync 클라이언트가 깨어나 `Read`/`Write`당 수백 ms의 지연이 붙습니다 — 일반적인 5–10 페이지 ingest에서 순수 I/O 대기만 15–30초가 추가될 수 있습니다. 권장 워크플로우:

1. **위키를 로컬 디스크에서 실행.** `wiki_root`를 동기화되지 않는 경로(예: `~/deep-wiki-local/`)로 지정합니다.

   > `wiki_root`가 vault가 아닌 로컬 경로일 때 SessionStart hook은 그 부모 디렉토리(`dirname "$WIKI_ROOT"`, 즉 `$HOME`)를 감시하여 noisy한 auto-ingest 후보를 만듭니다. 이 모드에서는 `~/.claude/settings.json`에서 hook을 비활성화하거나 `auto_ingest.ignore_globs: ['**']`를 설정하고, hook 기반 감지 대신 vault에서의 reverse-rsync에 의존하세요.

2. **vault로 스케줄 미러링** — launchd(macOS)나 cron에서 `rsync`. 플러그인에 외부 편집 충돌 감지가 없으므로 **additive sync만 사용 — `--delete`는 의도적으로 생략**합니다 (`--delete`는 다른 기기에서 한 편집을 조용히 파괴할 수 있음):
   ```bash
   rsync -a --backup --backup-dir="$HOME/.deep-wiki-rsync-backups/$(date +%Y%m%d-%H%M%S)" \
     ~/deep-wiki-local/ \
     "$HOME/Library/CloudStorage/GoogleDrive-.../Obsidian/Personal Vault/deep-wiki/"
   ```

3. **다중 기기 편집은 먼저 수동 reverse-sync가 필요.** 다른 기기의 Obsidian에서 페이지를 편집했다면, 다음 스케줄 push *전에* 그 편집을 로컬로 가져옵니다:
   ```bash
   rsync -a "$HOME/Library/CloudStorage/.../deep-wiki/" ~/deep-wiki-local/
   ```
   `auto_ingest:` 블록을 제거해도 auto-ingest는 **중단되지 않습니다** (whole-vault 감지로 되돌아가 *더* 공격적). 대신 `ignore_globs: ['**']`를 설정하거나 SessionStart hook을 비활성화하세요.

## Auto-ingest (SessionStart hook)

플러그인은 Claude Code 세션 시작마다 Obsidian vault의 **새/수정된 파일을 자동 감지**하는 SessionStart hook을 포함합니다 — 평소처럼 노트를 작성하면 위키가 최신 상태로 유지됩니다.

1. 세션 시작 시 hook이 마지막 스캔 이후 수정된 `.md` 파일을 vault에서 스캔합니다.
2. Obsidian CLI가 있으면 `obsidian recents`가 스캔을 보완합니다 (union + dedupe, mtime 검증).
3. 새 파일이 발견되면 Claude가 이를 auto-ingest하도록 지시받습니다.
4. 파일은 주제별로 그룹화되어 배치 처리되며, 이후 auto-lint가 실행됩니다.

스캔 제외: 할 일 파일, VPN 비밀번호, `.obsidian/` 내부, 위키 자체.

## Obsidian 호환성

- Obsidian vault 안에 위키를 만들면 그래프 뷰, backlink, 검색을 활용할 수 있습니다 — 또는 Obsidian 없이 순수 마크다운 디렉토리로 사용할 수 있습니다.
- `.wiki-meta/`는 Obsidian에서 자동으로 숨겨집니다.
- 표준 마크다운 링크(wikilink 아님)로 이식성을 보장합니다.

`/wiki-setup`이 Obsidian vault를 감지하면 권장 플러그인을 확인하고 상태를 보고합니다. Obsidian CLI가 설치되고 앱이 실행 중이면 위키 동작이 이를 사용해 더 풍부한 결과를 냅니다 (없으면 파일시스템 fallback):

| 기능 | CLI 커맨드 | Fallback |
|---------|-------------|----------|
| 콘텐츠 검색 | `obsidian search:context` | Grep |
| Orphan 감지 | `obsidian orphans` | 정규식 link 스캔 |
| Broken link 감지 | `obsidian unresolved` | 파일 존재 확인 |
| Backlink 분석 | `obsidian backlinks` | 불가 |
| 태그 통계 | `obsidian tags counts` | Frontmatter 파싱 |

**권장 Obsidian 플러그인:** Graph view(hub와 orphan 확인), Dataview(페이지 frontmatter 질의), Marp Slides(슬라이드 덱 렌더링), [Obsidian Web Clipper](https://obsidian.md/clipper)(웹 글을 빠른 ingest용으로 클리핑).

## 권장 도구

[Karpathy의 LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)에서 언급된, 워크플로우를 향상시키는 도구들입니다. `/wiki-setup`이 각 도구의 설치 여부를 확인하고 누락된 것의 설치 명령을 보여줍니다.

| 도구 | 용도 | 설치 |
|------|---------|---------|
| **qmd** | BM25/벡터 검색 + LLM 재정렬을 갖춘 로컬 마크다운 검색 엔진. MCP 서버로도 동작. | `npm install -g @tobilu/qmd` |
| **marp** | 마크다운 위키 페이지로부터 슬라이드(HTML/PDF/PPTX) 생성. | `npm install -g @marp-team/marp-cli` |
| **obsidian** | Obsidian CLI — 실행 중인 Obsidian 앱을 통한 검색, backlink, 태그, 속성. `/wiki-setup`이 자동 감지. | [Obsidian CLI](https://github.com/anthropics/obsidian-cli) |

```bash
qmd collection add ~/Obsidian/MyVault/wiki/pages   # qmd로 위키 인덱싱
marp wiki-page.md -o slides.html                   # 위키 페이지로부터 슬라이드 생성
qmd mcp --http                                     # qmd를 MCP 서버로 실행
```

## deep-work 연동

deep-work 세션 리포트를 위키로 ingest:

```bash
/wiki-ingest /path/to/deep-work/session/report.md
```

## 플랫폼 지원

| OS | 상태 | 비고 |
|---|---|---|
| macOS | Supported | macOS arm64와 Intel 고정 CI 증거. |
| Linux | Supported | Ubuntu 24.04 x64 고정 CI 증거. |
| Windows | Supported | Windows Server 2025 x64의 네이티브 Node 22 hook 증거; Git Bash/WSL2 runtime 불필요. |


## 런타임 지원 및 안전 경계

- **Writer 프로토콜.** 모든 변경은 협력적 현재 writer 계약을 사용합니다.
  lock 탈취는 완전한 탈취 후 owner와 directory 검사를 통과해야 합니다.
  모호한 lock에는 host를 중지한 상태의 개입이 필요하며, 같은 wiki에서
  구버전 동시 실행 금지입니다.
- **내구성 범위.** 보장은 마운트된 파일시스템과 프로세스 종료 내구성으로
  제한됩니다. 전원 손실, 손상된 원격 파일시스템, 같은 directory에 접근하는
  적대적 process까지 보장하지 않습니다.
- **Hook 실행.** 배포 hook은 Node 22입니다. Codex는 설치 plugin root를 미리
  확장하고 선택한 Windows command를 host 소유 `%COMSPEC% /C` 경계에
  위임합니다. 배포 shell-script runtime 없음이며, 과거
  `scripts/v0-probe/*-record.sh`는 maintainer probe일 뿐 runtime entrypoint가 아닙니다.
- **Runtime 표면.** 플러그인 MCP 서버나 native binary 없음이며 runtime package
  dependency도 없습니다. 위의 선택적 `qmd mcp` 명령은 외부 qmd 도구의 기능이지
  이 플러그인의 MCP가 아닙니다.
- **증거 범위.** 고정 job은 Windows Server 2025, Ubuntu 24.04, macOS arm64와
  Intel을 다룹니다. Windows 11 주장 없음입니다. 설치 Codex 증거는 plugin
  설치/탐색과 hook을 실행하기 위해 인증 없는 로컬 Responses fixture를
  사용했습니다. 이는 프로덕션 OpenAI API, login, model 품질, Windows 11,
  임의 사용자 머신, OS 수준 no-egress 인증이 아니다.
- **Upgrade와 rollback.** 첫 1.8 작업 전에 모든 host를 중지하고 완전한 인증
  backup을 만드세요. 1.8이 state를 썼다면 직접 in-place rollback은 지원하지
  않습니다. 중지 상태에서 1.8로 recovery한 뒤 1.7.1을 시작하기 전에 백업 전용
  downgrade를 수행해야 합니다. 1.9도 동일합니다: 1.9가 state를 쓴 뒤에는 중지
  상태에서 1.9로 recovery하고, 인증된 업그레이드 전 backup을 복원한 뒤 1.8.2를
  시작하세요 — 1.9의 in-flight journal(`contract_version` 2)은 1.8.x가 recover할
  수 없습니다. 1.10이 state를 쓴 뒤에는 중지 상태에서 1.10으로 recovery하고,
  인증된 업그레이드 전 backup을 복원한 뒤 1.9.x를 시작하세요.

## 철학

> *"지식 베이스 유지에서 지루한 부분은 읽기나 사고가 아니라 bookkeeping입니다. 상호 참조 갱신, 요약 최신화, 새 데이터가 기존 주장과 모순될 때 표시하기, 수십 페이지 간 일관성 유지. 인간은 유지 부담이 가치보다 빠르게 커지기 때문에 위키를 포기합니다. LLM은 지루해하지 않고, 상호 참조 갱신을 잊지 않으며, 한 번에 15개 파일을 건드릴 수 있습니다."*
> — Andrej Karpathy

사람의 역할은 소스를 큐레이션하고, 분석을 지휘하고, 좋은 질문을 하고, 그것이 무엇을 의미하는지 사고하는 것입니다. LLM의 역할은 나머지 전부입니다.

## 링크

- [CHANGELOG](CHANGELOG.ko.md) — 릴리스 이력
- [deep-suite](https://github.com/Sungmin-Cho/deep-suite) — 마켓플레이스와 나머지 플러그인
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## 라이선스

MIT
