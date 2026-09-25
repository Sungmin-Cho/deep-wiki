# 변경 이력

deep-wiki의 주요 변경사항을 기록합니다.

형식은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 따르며,
이 프로젝트는 [유의적 버전](https://semver.org/spec/v2.0.0.html)을 준수합니다.

## [Unreleased]

## [1.12.0] — 2026-09-25 (막힌 prune 진단)

### 추가

- 모든 terminal-prune 결과와 `lint fix`·`transaction prune`의 `terminal_prune` 보고가 그 패스가 복구하지 못한 것을 알려 줍니다: `blocked`는 마지막 결과가 거부인 store 항목을 최대 32개까지 `stage`, `reason`, 원인 `code`, 관찰한 `canonical` 경로 종류와 함께 나열하고, `blocked_count`는 정확한 개수, `blocked_truncated`는 목록이 잘렸는지, `deferred_count`는 호출자의 kind·나이·제외 정책 때문에 선택되지 않은 잔여물 수입니다. `complete`가 `false`면 개수는 하한이고, `null`은 그 패스가 관찰을 남기지 못했다는 뜻입니다. 거부 기록은 파일시스템을 읽지 않으며 삭제 가능 범위를 바꾸지 않습니다.
- 복구가 진전하지 못하면 `lint fix`가 일반 `TRANSACTION_RECOVERY_REQUIRED` 메시지를 반복하는 대신 `recovery made no progress`와 위 보고를 담아 실패하고, CLI가 보존 우선 계획을 출력합니다: 기존 `transaction quarantine` 명령을 순서대로 — 원본 operation 디렉터리 먼저, 그다음 각 `.prune-*` 세대 — 허용 목록 이름이고 원본 경로 상태가 허용할 때만 냅니다. 계획은 실행되지 않으며, 진전이 있던 패스는 재실행을 먼저 권하고, `transaction prune` 호출자에게는 같은 lock으로 다시 실행하거나 lock을 먼저 풀라고 안내합니다.

### 변경

- `lint inspect`와 snapshot이 `.prune-*` 디렉터리 개수와 정렬상 첫 이름을 알려 줍니다.
- 원본 경로가 아직 디렉터리인데 `.prune-*` 항목을 격리하면 `quarantine reservation must be a physical regular file` 대신 원본을 먼저 격리하라는 명시적 메시지로 실패합니다.
- source rename 전에 실패한 격리 시도가 재시도마다 meta만 든 번들을 남길 수 있다는 점을 storage layout에 적었습니다. 번들은 여전히 자동 삭제하지 않으며, 이를 제한하는 작업은 #62에서 다룹니다.
- 안전 검사, 삭제 권한, 오류 code, exit code, lock·journal 프로토콜과 모든 위키 상태 형식은 바뀌지 않았습니다. 이 변경은 두 plugin manifest와 package metadata 모두에서 별도 1.12.0 설치 식별자로 배포됩니다.

## [1.11.0] — 2026-09-15 (main-caller ingest)

### 변경

- `/wiki-ingest`가 Codex에서 이미 그랬던 것처럼 Claude Code에서도 main caller에서 실행됩니다. 호스트 공통 `main-caller-sequential` route 하나가 입력을 stable 순서로 하나씩 분석하고, 전체 소스와 디스크의 현재 페이지를 보면서 모든 페이지 본문을 작성하며, 다음 plan으로 넘어가기 전에 검증합니다. 이전에는 Claude Code가 이 작업을 Sonnet으로 고정된 subagent 세 개에 위임했고, page writer는 payload에 직렬화된 excerpt만 봤기 때문에 큰 ingest가 느리고 소스 맥락을 놓칠 수 있었습니다.
- 그 에이전트들이 담고 있던 grounding 규칙과 URL source-origin prompt contract는 이제 `/wiki-ingest` §3에 있으며, update는 디스크에서 읽은 전체 페이지를 기준으로 작성한다는 규칙도 함께 들어 있습니다.
- `/wiki-ingest`가 multi-source 병합에 필요한 manifest 규칙을 명시합니다: 병합된 페이지는 첫 기여 소스의 event에만 나열되고, 실패는 그 병합 group 전체를 manifest에서 빼고 실행당 한 번만 등록하며, 한 번에 다 볼 수 없을 만큼 큰 batch는 pending window를 promote하기 전에 group 단위로 commit합니다. runtime이 반환한 적 없는 snapshot page hash 대신 commit 자체의 `EXPECTED_HASH_CONFLICT` 검사를 설명하고, `wiki-schema.yaml`의 failure-state 설명은 legacy field 이름을 유지한 채 현재 runtime 동작에 맞췄습니다.
- `a5_fanout_threshold`와 `a5_worker_timeout_sec`는 계속 허용되는 wiki-local key이고 `config resolve --json`도 계속 보고하므로 기존 `.wiki-meta/.config.json` 파일은 유효하지만, 어느 host도 이 값을 읽지 않습니다.
- runtime, journal, manifest, wiki state 형식은 바뀌지 않았으며 page, provenance, lifecycle event는 기존 계약을 유지합니다.
- 이 변경은 두 plugin manifest와 package metadata 모두에서 별도 1.11.0 설치 식별자로 배포됩니다.

### 제거

- `agents/*.md` 네 파일을 모두 제거했습니다: `wiki-synthesizer-analysis`, `wiki-synthesizer-worker`, `wiki-page-writer`, dormant `wiki-synthesizer-inline`. `deep-wiki:wiki-*` 에이전트를 직접 dispatch하던 호출자는 `/wiki-ingest`를 실행해야 합니다. `npm run lint:agents`는 이제 agent 파일, manifest `agents` key, 위임 지시가 다시 나타나거나 ingest route record 또는 URL 규칙의 조항이 사라지면 실패합니다.

## [1.10.1] — 2026-08-26 (worker dispatch 계약)

### 수정

- `config resolve --json`이 검증된 runtime 경로를 통해 기본값을 포함한 effective `a5_fanout_threshold`와 `a5_worker_timeout_sec`를 노출합니다. 두 knob는 양의 safe integer여야 하므로 Claude가 사용할 수 없는 fanout threshold나 wall-clock budget을 받지 않습니다.
- Claude ingest dispatch는 각 qualified agent의 anchored input/output 계약을 정확히 읽습니다. named-agent resolution 실패와 invalid output은 계속 fail closed하고, effective timeout의 실제 non-response만 late output을 폐기한 뒤 affected work item을 stable main-caller `analyze` → `write` → `validate` route로 재처리합니다. complete manifest 검증 전에는 mutation하지 않습니다.

### 변경

- 이 수정은 두 plugin manifest와 package metadata 모두에서 별도 1.10.1 설치 식별자로 배포됩니다.

## [1.10.0] — 2026-08-25 (oversized 트랜잭션 격리)

### 수정

- `/wiki-setup`이 setup lifecycle event를 canonical `YYYY-MM-DDTHH:MM:SSZ` timestamp로 emit하므로, 문서화된 setup route가 더 이상 `MANIFEST_INVALID`로 실패하지 않습니다.
- oversized leftover transaction directory가 더 이상 모든 runtime inspection을 영구 `DEADLINE_EXCEEDED`로 막지 않습니다. Reader는 `TRANSACTION_OVERSIZED`로 분류하고, lock-held writer는 내부를 건너뛰며, isolatable 이름은 트리를 삭제하지 않고 `transaction quarantine`으로 옮길 수 있습니다. SessionStart ensure, lint fix, transaction prune, transaction quarantine은 isolatable oversized tree를 자동으로 옮깁니다. 번들은 `.wiki-meta/.quarantine/`에 남고 자동 삭제하지 않습니다. 해결 후에는 모든 host를 중지한 뒤 번들을 수동으로 폐기합니다.
- `transaction recover --wiki-root … --operation-id … --json`은 `--lock-token`이 없으면 self-locking이라 rollback quarantine `follow_up`을 바로 실행할 수 있습니다. 이미 lock을 보유한 호출자는 `--lock-token`을 계속 주입할 수 있습니다. self-acquire한 public recover가 `DEADLINE_EXCEEDED`를 만나면 token 없는 self-locking retry를 안내하고, `--lock-token` 힌트는 token을 주입한 내부 호출자에게만 남깁니다. 두 retry 힌트는 isolatable oversized 힌트와 같은 절대·shell-quoted `scripts/wiki-runtime.js` 경로를 쓰므로, 플러그인 checkout이 아닌 cwd에서도 명령을 그대로 실행할 수 있습니다.
- Reservation-only quarantine은 `.quarantine` 생성 직전과 이후 bundle·metadata·reservation mutation마다 `.prune-*` source가 여전히 없는지 다시 증명합니다. 최종 complete marker publish는 `writeMaintenanceMarker` `beforePublish`에서 그 부재를 다시 증명합니다. source가 다시 나타나면 reservation이 옮겨진 뒤 committed/incomplete `WIKI_STATE_FILESYSTEM`으로 실패하며, 거짓 complete를 기록하지 않습니다.
- Isolatable `TRANSACTION_OVERSIZED` 힌트는 실제 `scripts/wiki-runtime.js` 경로를 인용한 완전한 `node` 호출을 포함합니다. 직접 명령과 rollback 다단계 명령은 POSIX와 표시된 PowerShell에서 각각 독립적으로 복사할 수 있는 줄에 둡니다.
- prune의 디렉터리별 pressure probe 실패(`EACCES`/`EIO` 등 non-ENOENT)는 누적된 `processed`, `removed`, `complete: false`, `skipped_oversized`를 담은 `terminal_prune`으로 전달되므로, lint repair가 유효한 lock 아래에서 residue를 persist/promote한 뒤 rethrow할 수 있습니다.

### 변경

- `auto_ingest` policy는 이제 `<wiki_root>/.wiki-meta/.config.json`에 저장됩니다. `/wiki-setup`과 SessionStart가 동등한 global YAML block을 migration해 생성합니다. `/wiki-setup`은 `~/.deep-wiki-setup-authority.json`와 `~/.deep-wiki-setup.reserve/`도 생성합니다. divergent local/legacy policy와 대표 invalid local config shape는 fail closed합니다.
- Operator 문서는 bootstrap/legacy YAML alias, `CONFIG_CONFLICT` 및 `CONFIG_INVALID` recovery boundary, stopped-host direct edit, divergent physical home, explicit rebind, backup-only downgrade safety를 설명합니다.
- lint inspect는 isolation 이력을 informational `maintenance_residue`로 보고하며 `ok`를 뒤집지 않습니다. Partial setup은 `.quarantine`과 검증된 engine-owned `.runtime/scan-window-maintenance.json`을 허용합니다.

## [1.9.7] — 2026-08-05 (콘텐츠 메타데이터 및 중첩 prune 안전성)

### 수정

- 데스크톱 셸이나 동기화 클라이언트가 남긴 중첩 terminal·quarantine 메타데이터를 현재 owner와 전체 디렉터리 identity chain 아래에서 bounded scan-window 내부 선행 작업으로 회수합니다. regular file이 다른 프로세스에 잡혀 있으면 이후의 인증된 journal·backup·reservation·operation·quarantine 증거를 제거하기 전에 `terminal_prune.complete: false`를 보고하며, non-regular 인식 이름은 recovery 조건으로 남고 중첩 정리는 top-level `removed_junk`를 넓히지 않습니다.
- scan-window prune-name preflight가 missing `.transactions` child를 benign으로 처리하기 전에 parent-first `.wiki-meta` anchor를 수행하므로, symlink된 metadata parent는 `SCAN_WINDOW_FILESYSTEM`으로 fail closed합니다.
- `pages/`, `.wiki-meta/sources/`, `.wiki-meta/.versions/`의 regular AppleDouble 및 정확한 OS 메타데이터 파일은 content reader가 건너뛰고 `ignored_os_metadata`에 보고하며 삭제하지 않습니다. junk 이름의 symlink/directory는 fail-closed로 유지되고, `removed_junk`는 transaction store에만 해당합니다.

### 변경

- 이 수정은 두 plugin manifest와 package metadata 모두에서 별도 1.9.7 설치 식별자로 배포됩니다.

## [1.9.6] — 2026-08-04 (transaction store 잡파일 내성)

### 수정

- 데스크톱 셸이나 동기화 클라이언트가 `<wiki_root>/.wiki-meta/.transactions/`에 자체 메타데이터 파일을 남겨도 더 이상 위키 전체가 잠기지 않습니다. 기존에는 그 안의 디렉토리가 아닌 항목 하나 — 클라우드 스토리지에 둔 Obsidian vault에서 흔한 macOS `.DS_Store`가 대표적입니다 — 만으로 transaction 상태를 검사하는 모든 경로(`snapshot`, `commit`, `index read`, `transaction recover`, `lint inspect`, `lint fix`)가 `TRANSACTION_RECOVERY_REQUIRED`로 실패했고, bounded debris sweep은 non-directory를 건너뛰었기 때문에 배포된 어떤 명령으로도 해소할 수 없었습니다. 이제 인식된 OS 메타데이터는 무해한 debris로 처리합니다. lock 없이 동작하는 reader는 이를 건너뛰고, lock을 보유한 debris sweep이 `commit`, `lint --fix`, scan-window 유지보수 중에 회수합니다. 인식은 정확한 이름 일치와 AppleDouble `._` 접두사에 한정되며, 제거 직전에 타입을 다시 증명한 일반 regular file에만 적용됩니다. 인식되지 않은 잔여 항목과 인식된 이름을 쓴 symlink는 여전히 recovery를 요구하고, 따라가지도 제거하지도 않습니다. 회수는 recursive 삭제가 아닌 `unlink`입니다. 이 클래스는 본래 외부 프로세스가 만들고 붙잡고 있는 파일이므로, unlink가 거부되면(`EPERM`, `EACCES`, `EBUSY`, `EROFS`, `ETXTBSY`) 파일을 그대로 두고 감싸는 route를 raw errno로 실패시키지 않고 계속 진행합니다. reader가 이미 그 파일을 관용하고 이후 pass가 재시도합니다. 이 관용은 unlink에만 적용됩니다 — owner token이나 store anchor를 증명하는 도중 발생한 실패는 errno가 무엇이든 fail closed입니다. `wiki-runtime lint fix`는 작업 전후의 store를 비교해 실제로 회수한 항목만 `removed_junk`로 보고하므로 nested commit sweep의 회수까지 포함하며, 인식된 메타데이터가 남아 있는지는 `removed_junk_complete`로 알립니다.
- 이제 transaction 클래스 debris를 모두 정리한 뒤에야 OS 메타데이터를 처리합니다. 무해한 파일이 reader에 치명적인 유일한 클래스인 `cancelled` 정리를 밀어내거나 앞질러 소진하지 못하게 하는 것은 두 번째 예산이 아니라 순서입니다. 따라서 한 pass의 변경 상한은 여전히 총 `limit`이며, 제거 불가능한 파일이 무한 재시도되지 않도록 junk 회수는 성공이 아닌 **시도**마다 예산을 소비합니다.

### 보안

- bounded transaction debris sweep이 열거·삭제 전에 자기 저장소를 먼저 anchor합니다. `readdirSync`는 디렉토리 symlink를 따라가므로, 기존에는 `.wiki-meta` 또는 `.wiki-meta/.transactions`가 symlink일 때 sweep이 위키 바깥 항목을 삭제할 수 있었고, symlink된 `.wiki-meta` 아래에 `.transactions`가 없으면 `commit`이 위키 바깥에 transaction 디렉토리와 journal을 생성할 수 있었습니다. lock 소유권은 "누가 쓸 수 있는가"만 증명할 뿐 "어디에 쓰는가"는 증명하지 않습니다. 이제 `.wiki-meta`와 `.wiki-meta/.transactions` 모두 실제 경로와 기대 경로가 일치하는 물리 디렉토리임을 증명하고, 그 identity(device·inode·birth time — 재사용된 inode가 위장할 수 없도록)를 모든 제거 직전마다 owner token과 함께 재증명하므로 sweep 도중 부모가 교체되는 경우도 잡아냅니다. `lint --fix`와 scan-window 유지보수는 scan-window preflight로 이미 anchor하고 있었지만 `commit` 경로에는 그 가드가 없었고, 이제 무엇도 생성하거나 삭제하기 전에 `WIKI_STATE_FILESYSTEM`으로 fail closed합니다. sweep의 anchor는 sweep이 반환되면 수명이 끝나므로, transaction 생성 경로가 `.transactions` 생성 직전과 activation 디렉토리를 제자리로 rename하기 직전에 anchor를 다시 증명합니다.
- 알려진 잔여 위험: anchor와 그것이 보호하는 제거를 이 런타임에서 원자적으로 묶을 수 없습니다. Node에는 handle 기반 `unlinkat`이 없고 이 플러그인은 native binary를 배포하지 않으므로, 마지막 검사와 syscall 사이의 명령 구간에서 상위 경로가 교체되면 예방이 아니라 사후 탐지가 됩니다. 이는 기존 위협 모델의 범위 안입니다 — mutation은 cooperative current writer contract로 통제되며, 협조하지 않는 적대적 로컬 프로세스는 애초에 그 계약의 대상이 아니었습니다. 어떤 durability·recovery 주장도 이 간극에 의존하지 않습니다.

### 변경

- 이 런타임 변경은 두 plugin manifest와 package metadata 모두에서 별도 1.9.6 설치 식별자로 배포됩니다.

## [1.9.5] — 2026-08-01 (lock 경합 관측성)

### 수정

- 이제 `wiki-runtime lock acquire --json`의 모든 `LOCK_CONTENDED` 결과가 exit code 3, 빈 stdout, 단일한 안정적 JSON stderr envelope로 보고됩니다. 완전하고 canonical한 owner는 token을 제외한 `operation`, `pid`, `hostname`, `acquired_at` 필드의 `holder`로 투영하고, malformed·incomplete·extra-field·ownerless 증거는 `holder: null`로 fail closed합니다. 활성 release transition에서 발생한 경합까지 공개 메시지를 항상 `wiki lock is contended`로 정규화하며, lock 획득·dead-owner 자체 복구·recovery·release·liveness 동작은 변경하지 않습니다([#40](https://github.com/Sungmin-Cho/deep-wiki/issues/40)).

### 변경

- 이 공개 CLI 계약은 두 plugin manifest와 package metadata 모두에서 별도 1.9.5 설치 식별자로 배포됩니다.

## [1.9.4] — 2026-07-31 (lint repair 회수)

### 수정

- 완료된 scan-window `ensure` journal은 인증된 scan-window 상태가 회수 가능함을 증명한 뒤 더 이상 무제한 누적되지 않습니다. 명시적 `wiki-lint --fix`가 현재 lock 아래에서 자체 복구 회수를 수행하고, 유계 `transaction prune` 명령은 eligible transaction 디렉터리 전체를 새 identity-bound sibling quarantine으로 원자 이동한 뒤 인증된 journal을 삭제합니다. 중단된 quarantine은 식별 가능한 상태로 남아 이후 유계 pass가 다시 처리합니다. exact journal-copy reservation은 quarantine 제거가 끝날 때까지 canonical source generation을 닫아 두고, 원본 journal unlink 뒤 중단되어도 exact fsynced backup으로 복구할 수 있습니다. 두 파일은 exclusive crash-recoverable pending publication을 사용하며, 이후 유계 pass는 partial publication, backup-only·빈 quarantine, 고아 exact reservation도 마무리합니다. 정리는 discovery·validation·복구 가능한 mutation phase 전반에서 deadline을 다시 검사합니다. age 조건을 충족한 완전 검증 `cleaned` scan-window 디렉터리만 제거하면서 증명되지 않은 created 상태와 in-flight·malformed·foreign-kind·linked·ambiguous 상태를 보존합니다. 결과의 `complete` 필드는 전체 순회와 deadline·limit로 잘린 pass를 구분합니다.
- Fractional-clock `lint fix` 작업은 이제 commit 전에 manifest event timestamp를 정초 단위 UTC-Z로 canonicalize하므로, 성공한 repair가 더 이상 `MANIFEST_INVALID`로 끝나지 않습니다.

### 변경

- 이 runtime 변경은 두 plugin manifest와 package metadata 모두에서 별도 1.9.4 설치 식별자로 배포됩니다.

## [1.9.3] — 2026-07-30

### 수정

- 이제 sync-drive 트랜잭션 journal이 파일시스템 메타데이터 호출 안에서 멈춰도 `wiki-runtime snapshot`이 무기한 기다리지 않습니다([#39](https://github.com/Sungmin-Cho/deep-wiki/issues/39)). Snapshot 실행을 감독되는 read-only 자식 프로세스로 분리하고, 잠재적으로 멈춘 syscall 바깥에 parent timer를 둡니다. 12초 timer가 발화하면 parent가 worker tree 종료를 요청하고 pipe와 child handle을 분리한 뒤, worker `close`를 기다리거나 복구 증거를 변경하지 않고 실행 가능한 `DEADLINE_EXCEEDED` 안내를 반환합니다. POSIX와 native Windows 모두 실행된 종료 요청을 보수적으로 unconfirmed로 보고하며, launch 또는 요청 실패는 requested도 confirmed도 아닌 상태로 보고합니다. 즉시 읽을 수 없는 journal은 같은 stopped-host/readability 복구 경계와 함께 `TRANSACTION_RECOVERY_REQUIRED`로 fail closed합니다.
- SessionStart scan-window 영속화를 감독되는 자식 프로세스로 분리했습니다. 시간초과 시 자식 트리 종료 완료를 확인한 뒤 해당 자식 PID와 일치하는 same-host dead lock만 회수하며, 일반 lock 획득도 live·foreign·malformed·ownerless contention을 약화하지 않고 같은 인증된 dead-owner 경우를 자체 복구합니다.

## [1.9.2] — 2026-07-27 (컨텍스트 다이어트)

### 변경

- 에이전트 문서를 AGENTS-first 단일 소스로 재구성: AGENTS.md가 공유 런타임 규칙(storage layout, lifecycle actions, 불변식, 컨벤션, 릴리스 워크플로우)을 보유하고, CLAUDE.md는 `@AGENTS.md` import + Claude Code 전용 노트만 남긴 thin wrapper가 됩니다.
- AGENTS.md와 CLAUDE.md가 크게 짧아져 세션 컨텍스트 예산을 그만큼 실제 작업에 쓸 수 있습니다. 중복된 디렉토리·storage 트리, 주석 달린 lifecycle action 목록, 이미 CONTRIBUTING.md가 다루는 컨벤션은 다시 서술하는 대신 정본 위치를 가리킵니다.
- 스킬과 에이전트 description이 짧아지고 동작을 앞세우도록 바뀌었습니다. 트리거 문구는 모두 그대로여서 기존 호출 경로는 동일하게 동작합니다.

### 수정

- 1.9 백업 전용 downgrade 경계(`contract_version` 2 in-flight journal은 1.8.x가 recover 불가)를 AGENTS.md, CONTRIBUTING.md, README 안전 경계 섹션(EN + KO)에 명시했습니다.
- 문서화된 릴리스 워크플로우가 더 이상 자동 생성되는 deep-suite README 플러그인 표를 직접 편집하도록 안내하지 않습니다. 실제로 실행되는 순서를 제시합니다: `release:bump`가 marketplace와 자동 생성 문서 영역 편집을 자동화하고, Codex 미러와 워크플로우 가이드의 버전 서술은 여전히 수동 편집이 필요하며, suite 커밋·푸시도 수동입니다.
- 선택적 `.wiki-meta/.config.json` fan-out 노브를 에이전트 가이드에서 런타임 설정처럼 서술하던 부분을 제거했습니다. 1.9.2 release 시점에는 배포되는 코드 중 이 파일을 읽는 곳이 없었습니다. 선언은 호출자가 준수하는 `wiki-schema.yaml`에 남았고, 현재 runtime은 wiki-local 파일을 `auto_ingest` owner로 읽습니다.

## [1.9.1] — 2026-07-22

### 수정

- SessionStart vault 변경 알림이 공용 `hookSpecificOutput.additionalContext` JSON 계약을 사용하여 Codex hook 오류를 방지하고, 변경 없음의 무출력 및 fail-open 동작은 그대로 유지합니다.

## [1.9.0] — 2026-07-21 (커밋 deadline 스케일링 — hash-only catalog seal + crash-safe cancel)

### 수정

- 대형 vault에서 `wiki-runtime commit`이 단일 논리 커밋을 여러 번의 `transaction recover` 호출로 쪼개던 문제를 해결했습니다 ([#30](https://github.com/Sungmin-Cho/deep-wiki/issues/30) Issue 2). per-commit 비용이 diff가 아니라 카탈로그 크기에 비례했습니다: `buildPlan`이 미변경 page/version/source를 전부 full-byte `before==after` 아티팩트로 seal해서 journal(`atomicWriteFile`의 fsync로 최대 ~14회 재영속)과 staging(2N fsync 쓰기)을 부풀렸고, 이 구간에 deadline 체크가 없어 고정 12초 예산이 staging에서 소진된 뒤 `wiki-state:publish:versions`에서 오해를 부르며 터졌습니다. 이제 미변경 파일은 hash-only `catalog_seal`(`{relative_path, sha256}`)로 기록되어 journal 영속화와 staging이 O(diff)로 떨어지고, 실측된 590·~1,406 페이지 케이스가 단일 커밋에서 12초 안에 여유 있게 완료됩니다.

### 변경

- journal `contract_version`을 1 → 2로 올렸습니다(`catalog_seal`, `catalog_seal_sha256`, `catalog_seal_cursor` 추가). `validateJournal`이 레거시 v1 또는 v2 exact-key journal을 모두 수용하므로, 업그레이드 전 중단된 v1.8.x 커밋은 원래 의미론대로 recover되고, v1.9 in-flight journal은 v1.8.x가 거부합니다(backup-only downgrade — `CLAUDE.md`의 갱신된 안전 경계 참조). receipt 형상과 성공 result 형상은 무변경입니다.
- drift 대응을 cancel-only로 전환했습니다. 재개형 drift 스캔이 커밋 도중 미변경 카탈로그 파일의 변경/삭제를 감지하면, transaction을 crash-safe하게 해체하고(tombstone-before-destruction: durable한 `cancelled.json` 결정점이 모든 파괴적 단계보다 먼저) `TRANSACTION_CANCELLED`(exit 4, receipt 없음)로 종료합니다 — 낡은 파생 index를 커밋하지 않습니다. fail-before-stale-publication 속성은 보존되고, 동시 외부 편집을 clobber할 수 있던 기존 전체 스냅샷 복원은 cooperative-writer 계약 하의 데이터 안전성 개선으로 의도적으로 폐기했습니다. Source provenance는 커밋-시점 / 무증폭 보장으로 재정의했습니다.

### 추가

- journal-first 원자적 트랜잭션 활성화: 트랜잭션 디렉터리는 journal이 존재할 때만 reader에게 보입니다(`.activate-<pid>-<uuid>/` 아래에 만든 뒤 `renameSync`). "journal 없음 ⟹ 살아있지 않음"이 프로토콜 불변식이 되어 lock-free reader가 살아있는 pre-journal writer를 잔해로 오인할 수 없습니다. 유계·lock-보유·deadline-aware `sweepTransactionDebris`(공유 leaf 모듈 `hooks/scripts/runtime/transaction-debris.js`)가 버려진 활성화/트랜잭션 잔해를 reader 차단 없이 수렴시키며 journal 보유 디렉터리는 절대 건드리지 않습니다. 그 외: stage/verify/publish 전반의 per-artifact 재개형 deadline checkpoint, commit·recover 공유 lock-owner-guarded runtime-manifest 정리, `DEADLINE_EXCEEDED` 출력에 붙는 `transaction recover` 재개 힌트.

### 리뷰

- 설계는 6라운드 크로스모델 리뷰 루프(Claude Opus + Codex, adversarial 패스 포함)로 수렴했으며, cancel/tombstone crash-safety 행렬과 journal-first 활성화 불변식을 reader-race·부분-teardown 엣지에 대해 강화했습니다. 구현은 gpt-5.6-sol이 수행했고, 모든 커밋이 스위트 green을 유지했습니다.

## [1.8.2] — 2026-07-21 (Windows st_dev 비대칭으로 인한 atomic write·lock 획득 실패 수정)

### 수정

- 최신 Windows에서 wiki lock 획득(및 다른 모든 runtime 상태 쓰기)이 더 이상 영구 실패하지 않습니다. `atomicWriteFile`은 temp 파일 소유권을 fd 기반 `fstatSync` identity와 경로 기반 `lstatSync` identity의 비교로 봉인하는데 — runtime에서 유일한 교차 API stat 비교 — 이 seal이 엄격한 `st_dev` 동등성을 포함했습니다. Windows 11 24H2 / Server 2025에서 libuv ≥ 1.49.0(Node 22.12.0부터 번들)은 경로 stat을 `GetFileInformationByName` fast path로, fd stat은 여전히 `NtQueryVolumeInformationFile`로 처리하므로 같은 파일에 대해 두 API가 서로 다른 `st_dev`를 보고할 수 있습니다: libuv 1.51.0 이전(Node 22.12.0–22.16.0)에는 64-bit 대 절단된 32-bit 볼륨 시리얼, 이후에도 시리얼 미가용 환경(예: FSLogix 계열)에서는 0. 그 결과 모든 `owner.json` 쓰기가 `FILESYSTEM_IDENTITY_UNAVAILABLE`로 중단되어 `/wiki-*` lock 획득이 불가능했습니다. seal은 이제 방향성 `devicesCompatible` 술어 — 정확 일치, 한쪽 0, 또는 절단된 32-bit fd측 시리얼이 경로측 하위 32비트와 일치(정확히 문서화된 Windows 표현들) — 를 사용하며, `ino`와 `birthtimeNs`는 여전히 엄격 비교되고 진짜 다른 디바이스는 계속 거부됩니다. 회귀 테스트는 수용되는 두 Windows 형태, 종단 `acquireLock` 경로, 거부 3케이스(다른 디바이스, fd측 비절단형의 우연한 low-32 일치, inode 재사용 세대 변경)를 포괄합니다.

### 리뷰

- 이 수정은 3라운드 교차 모델 리뷰 루프(Claude Opus + Codex review + Codex adversarial)를 거쳤습니다. 라운드 1–2에서 "dev 전면 제거"에서 위의 방향성 형태로 술어를 조였고, 라운드 3에서 Opus와 Codex review 승인으로 종료됐습니다. `lock.js` / `scan-window.js`의 lstat-vs-lstat identity seal은 이 비대칭의 영향을 받지 않으므로 의도적으로 엄격 비교를 유지합니다.

## [1.8.1] — 2026-07-20 (이식 가능한 Obsidian CLI 탐지 및 ingest 통합)

### 추가

- `/wiki-setup`이 Obsidian을 기록해 둔 경우, `/wiki-ingest`가 이제 선택적 읽기 전용 vault 컨텍스트에 Obsidian CLI를 사용합니다. 새 runtime 브리지(`wiki-runtime.js obsidian search|backlinks|tags --json`)는 프로브와 같은 탐색 로직을 재사용하고, 설정된 vault를 이름으로 타게팅하며, 읽기 전용 서브커맨드만 허용하고, 인자 값을 검증하며, `shell:false` + 10초 kill timeout + 바운드된 출력으로 실행합니다. ingest 스킬은 resolve된 `obsidianCli.enabled` 설정으로 호출을 게이팅하고 모든 실패를 정보성으로 취급하므로, Obsidian이 없거나 비활성화된 환경에서 ingest 동작은 변하지 않습니다. runtime도 설정이 Obsidian을 비활성화하면 호출을 거부합니다. 또한 브리지는 앱 연결 명령이 결과 스트리밍 전에 exit 0 + 완전 빈 출력으로 종료되는 업스트림 CLI 레이스(검색 약 3회 중 1회 관측)를 흡수합니다: 진짜 무결과는 항상 메시지를 출력하므로, 완전히 빈 응답만 고정 한도 내에서 재시도합니다.

### 수정

- `/wiki-setup`의 Obsidian 가용성 프로브가 더 이상 호출자 `PATH`에서의 bare `obsidian` 이름 해석에 의존하지 않습니다. 기존 직접 `{"executable":"obsidian"}` 프로브는 대화형 셸 프로필이 우연히 앱 디렉터리를 `PATH`에 추가했을 때만 (macOS에서는 `Obsidian` 앱 바이너리의 대소문자 무시 매칭을 통해서만) 동작했기 때문에, 비대화형 호스트 — Codex `shell:false` 구조화 exec, hook, 사용자 프로필이 없는 환경 — 에서는 Obsidian 1.12+가 설치·실행 중이어도 CLI 없음으로 보고됐습니다. 탐지는 이제 이식 가능한 Node runtime(`wiki-runtime.js probe obsidian --json`) 안에서 수행됩니다: 절대경로 `DEEP_WIKI_OBSIDIAN_BIN` override를 우선 확인하고, 두 가지 바이너리 대소문자(및 Windows 실행 확장자)로 `PATH`를 스캔한 뒤, 플랫폼별 잘 알려진 설치 경로(macOS 애플리케이션 번들, `%LOCALAPPDATA%\Programs\obsidian`, Linux system/flatpak/snap 경로)로 폴백합니다. 각 후보는 `shell:false`, 3초 kill timeout, 바운드된 출력 캡처로 읽기 전용 실행되며 최대 3개 후보만 spawn합니다. 결과는 `found`(CLI 바이너리 존재)와 `reachable`(실행 중인 앱이 vault로 응답)를 구분하므로, setup이 단순 "unavailable" 대신 프로브 실패 이유를 보고합니다.

### 변경

- 배포 스킬에 더 이상 직접 non-Node 실행 파일이 없습니다. 기존 직접 `obsidian` exec 블록이 유일한 예외였고, 이를 Node runtime 프로브로 교체하면서 executable contract는 모든 스킬에서 모든 non-`node` 실행 파일을 거부하며(`EXECUTABLE_NOT_ALLOWED`), `wiki-setup` allowlist에 고정 `['probe','obsidian','--json']` argv contract가 추가됐습니다.

## [1.8.0] — 2026-07-19 (Node 22 runtime, 네이티브 Windows hook, Codex 검증)

### 변경

- 배포 Bash SessionStart scanner와 persistence 경로를 Claude Code와 Codex가 공유하는 이식 가능한 Node 22 runtime으로 교체했습니다. 배포 shell-script runtime 없음: Codex는 `commandWindows`를 선택하고 plugin root를 미리 확장한 뒤 host 소유 `%COMSPEC% /C` 경계로 실행합니다.
- scan-window, wiki transaction, setup, ingest, lint-fix, rebuild의 상태 변경을 동일한 협력적 현재 writer 프로토콜로 통합했습니다. writer는 변경 전에 완전한 탈취 후 owner와 directory 검사를 인증합니다. 모호한 lock은 host를 중지한 상태의 개입이 필요하며 구버전 동시 실행 금지입니다.
- 내구성 주장은 마운트된 파일시스템과 프로세스 종료 내구성으로 제한됩니다. 전원 손실, 원격 파일시스템, 적대적 프로세스 보장이 아닙니다. 1.8 write 이후에는 백업 전용 downgrade만 지원합니다.

### 호환성과 증거

- Ubuntu 24.04 x64, macOS arm64와 Intel, Windows Server 2025 x64의 고정 CI authority를 추가했습니다. Windows 11 주장 없음입니다.
- 정확한 Codex 0.144.1 Windows 설치 smoke가 marketplace 설치/탐색, 설치 byte, model 요청 전 배포 hook effect, 직접 설치 supervisor 출력, untrusted no-effect 경로, `commandWindows` root 확장을 인증합니다.
- 설치 Codex 테스트는 인증 없는 로컬 Responses fixture를 사용했습니다. 프로덕션 OpenAI API, login, model 품질, Windows 11, 임의 사용자 머신, OS 수준 no-egress 인증이 아니다.
- 플러그인 MCP 서버나 native binary 없음, runtime dependency 없음, 실행 가능한 shell entrypoint 없음입니다. 세 `scripts/v0-probe/*-record.sh` 파일은 maintainer 전용 과거 probe로만 남습니다.

## [1.7.1] — 2026-07-07 (wiki-lint --fix lock + .last-scan 승격 원자화)

### 수정

- `/wiki-lint --fix`가 이제 위키 상태를 변경하기 전에 위키 lock을 획득합니다. 기존에는 `.pending-scan` drop과 version prune이 `.wiki-lock` 없이 실행되어, hook 구동 `/wiki-ingest`(lock 보유)와 동시에 돌면 `index.json` lost-update, scan window 훼손, `.versions/` prune 경쟁이 발생할 수 있었습니다 — invariant #3(lock atomicity) 위반. 이제 `--fix` 변경은 자기완결 단일 lock 블록 안에서 실행됩니다(획득 → EXIT trap 해제 → lock 하 재독·재검증 → 변경). 경합 시에는 read-only 진단은 그대로 출력하면서 변경만 soft-skip합니다. index drift 수리는 해당 lock 해제 이후에만 `/wiki-rebuild`에 위임합니다(rebuild의 lock 획득은 비재진입).
- hook 구동 `.last-scan` 승격 쓰기를 원자화했습니다(임시 파일 + `mv`). 저장소의 `.pending-scan`·`index.json` writer와 동일한 방식입니다. 기존의 직접 `echo > .last-scan` redirect는 쓰기 도중 중단되면(예: 네트워크 볼륨에서 15초 SessionStart hook 예산) 파일이 empty/truncated로 남을 수 있었습니다.
- `/wiki-ingest` A5-fanout 쓰기 경로(Step 7.6.C)를 다중 블록 lock 패턴으로 전환했습니다. 이 lock은 Step 7.6.C → 7.6.G(별도 Bash 블록)에 걸쳐 유지되어야 하는데, 획득 블록이 무조건 `EXIT` trap을 등록해 블록이 끝나는 즉시 발화 → Step 7.6.D-G가 lock 없이 실행되며 동시 쓰기 창을 재개방했습니다(wiki-rebuild round-4가 고친 조기 해제 버그와 동일). 이제 획득 블록은 실패 전용 cleanup을 등록하고, Step 7.6.G가 성공 경로의 명시적 해제를 유지하며, Step 7.6.F도 자체 abort 경로에서 lock을 해제합니다(lock이 그 지점까지 유지되므로). lock 패턴 카탈로그도 Step 7.6.C를 Pattern 1 → Pattern 2로 재분류했습니다.
- `/wiki-ingest` F1 all-dropped 3-strike escape의 `.last-scan` 승격을 가드했습니다. 기존에는 timestamp 검증·monotonicity 비교 없이 raw `mv .pending-scan .last-scan`을 실행해, stale하거나 malformed한 stuck window가 `.last-scan`을 regress/corrupt할 수 있었습니다(invariant #2 위반). 이제 Step 11 승격 가드를 공유합니다 — window가 현재 `.last-scan`보다 엄격히 새로운 유효 timestamp일 때만 `.last-scan`을 전진시킵니다. stuck 상태(`.pending-scan` + retry 카운터)는 temp 파일 rename이 확인된 **후에만** 정리합니다 — rename 실패(ENOSPC / EACCES / network FS) 시 둘 다 보존하고 fatal 에러와 함께 종료하여, 창의 유일한 기록을 잃는 대신 다음 훅 사이클이 재감지·재시도합니다. invalid/stale window(`.last-scan` 쓰기 시도 없음)는 여전히 `.pending-scan`을 drop해 stuck window를 해제합니다. 두 개의 `promote_pending_scan_to_last_scan` 축약과 Step 7.5.M-D 3-strike prose에도 이 공유 가드 절차를 참조하도록 주석을 달았습니다.
- `/wiki-ingest` F1 all-dropped 3-strike retry 카운터가 3에 절대 도달하지 못하던 문제를 수정했습니다. 카운터 파일의 키는 `.pending-scan` 창(콜론을 포함하는 ISO-8601 타임스탬프)인데, 읽기가 `${saved%%:*}`를 써서 첫 콜론에서 키를 잘라(`2026-06-01T00`) 현재 창과 절대 매치되지 않고 매 실행 count를 1로 리셋했습니다. 그 결과 3-strike escape(및 위의 가드 승격)가 실 훅 흐름에서 도달 불가였고 `.pending-scan`이 영구 stuck 상태였습니다. 이제 마지막 콜론 기준(`${saved%:*}`, 전체 타임스탬프 보존)으로 잘라 count를 정수 검증합니다.
- `/wiki-ingest` post-ingest auto-lint(Step 7.6.G)이 위키 lock 해제 후 `.versions/` 백업을 prune하던 문제를 막았습니다. Step 13 주석은 retention prune이 "safe outside the transaction"이라 주장했으나, prune은 mutation이라 무-lock 실행은 invariant #3 위반입니다 — 동시 ingest가 방금 해제된 lock을 잡으면 자신의 새 백업·index 수리와 prune이 경쟁합니다. 이제 post-lock auto-lint은 read-only 진단만 하고, retention prune은 wiki-lint §13 Auto-Fix Phase A(`.wiki-lock` 자체 획득, 경합 시 soft-skip)를 통해 lock 하에서만 실행됩니다.
- `/wiki-ingest` Step 13(Auto-Lint) **섹션 본문 자체**의 무-lock mutation 지시문을 제거했습니다. 앞선 수정은 Step 7.6.G 주석만 고쳤으나, 섹션은 여전히 lock 해제 후 "Auto-fix"(index.json 항목 추가/제거, 초과 `.versions/` prune)를 수행하라고 지시했습니다. 이제 섹션은 read-only이며, auto-fix 가능한 mutation은 자체 lock을 획득하는 `/wiki-lint --fix`(§13 Phase A/B)에 위임합니다(index.json은 ingest 트랜잭션 중 Step 9가 이미 lock 하에서 동기화 유지).
- `.pending-scan-retry-count` 파일의 온디스크 형식을 통일했습니다. F1 단일소스 경로는 이 파일을 verbatim `.pending-scan` 타임스탬프 키(`<ISO>:<count>`)로 쓰는데, 멀티소스 Step 7.5.M-D 계약은 같은 공유 파일을 `<window_epoch>:<count>`로 정의했습니다. 두 경로가 서로 다른 키 형식으로 읽고 써서 상대의 카운터를 리셋 → 3-strike escape가 지연/불능이었습니다. 이제 멀티소스 계약도 동일한 verbatim-`.pending-scan` 키 + 전체 문자열 동등 비교 + 콜론-안전 파싱(`${saved%:*}`)을 사용합니다. epoch 변환은 bash-3.2 / BSD-`date` 이식 가능한 ISO→epoch가 없어 기각했습니다.
- `/wiki-ingest` A5-fanout 중간 lock-보유 블록(Step 7.6.D·7.6.F)에 실패-전용 해제 trap을 추가했습니다. Pattern 2 전환 후 `.wiki-lock`이 Step 7.6.C → 7.6.G(별도 Bash 블록)에 걸쳐 유지되는데 7.6.C만 실패-해제 trap을 등록해, 중간 블록의 일반 명령 실패가 lock 보유 상태로 블록을 비-0 종료시켜 lock을 잔존(모든 writer 차단)시킬 수 있었습니다. 이제 각 중간 블록이 비-0 종료 시에만 lock을 `rmdir`하는 `cleanup_*` trap(wiki-rebuild `cleanup_step3` 모델)을 등록하고, 성공 시에는 Step 7.6.G 명시 해제까지 lock을 유지합니다. Steps 8-11은 Step 7.7.F `on_metadata_failure` 해제로 계속 커버됩니다.
- cleanup `trap`을 "lock 획득 시점에 등록"하라던 구 lock-해제 지침을 재작성했습니다. 다중 블록 main ingest(Step 3 획득 → Steps 4-11 변경 → Step 12 해제)에서 획득 시점 무조건 trap은 Step 3 블록 종료 시 발화해 lock을 조기 해제 — Pattern 2가 고친 버그와 동일합니다. Step 3·Step 12·crash 노트·Error Handling 항목이 이제 trap 형태를 lock-pattern 카탈로그에 위임합니다(다중 블록=변경 블록마다 실패-전용 trap / 단일 블록=무조건 해제 trap 허용). 또한 미명시로 읽히던 version prune의 lock 규율을 `wiki-schema`(`## Versioning`)·`wiki-rebuild`(Step 5)에서 명시 — 둘 다 prune이 lock 하에서 실행됨(invariant #3)을 서술합니다.
- 기계가독 스키마의 retry-counter 형식 통일을 마무리했습니다. R4는 SKILL.md prose만 갱신하고 `skills/wiki-schema/wiki-schema.yaml`(정본 스키마)과 `ingest-fail` 로그라인 계약이 여전히 구 `<window_epoch>:<count>` epoch 키를 선언하고 있었습니다. `wiki-schema.yaml` `retry_counter.format`과 `ingest-fail` action 노트는 이제 `<pending_scan_iso>:<count>`를 선언하고, `ingest-fail` 로그 필드는 `window_epoch`(int) 대신 `window`(`.pending-scan` ISO 문자열)입니다. schema↔SKILL.md sync 테스트가 한쪽이라도 epoch 키로 되돌아가면 실패합니다.
- `/wiki-ingest` 3-strike 터미널 `ingest-fail` 로깅을 idempotent + emit-first로 만들었습니다(F1 all-dropped + Step 7.7.B all-workers-fail 두 경로 모두). 이제 터미널 행은 가드 승격이 scan window를 해제하기 **전에** 기록되어 — 로그 쓰기 실패가 창 해제를 막아 "감사 기록 없는 3-strike"(fail-open)를 방지 — window(+source)로 키됩니다: escape에 재진입한 재시도 사이클은 해당 window의 터미널 행이 이미 있으면 emit을 skip하므로, `.pending-scan`+retry 카운터를 보존하는 rename 실패도 터미널 행을 중복 생성하지 않습니다. `ingest-fail` emit 지점 grep으로 이 둘이 유일한 3-strike 경로임을 확인했습니다.
- 정본 `auto_lint` 계약을 read-only 위임 모델로 재작성했습니다. `wiki-schema.yaml`과 `wiki-schema` `## Auto-Lint` 섹션이 여전히 index drift/excess versions/stale `.pending-scan`에 대해 `auto_fix: "Fix silently without user action"`을 약속해 post-ingest auto-lint의 read-only 전환과 모순됐습니다. 스키마는 이제 `mode: read-only-diagnostics`와 `/wiki-lint --fix`(lock 하 mutation)로 위임하는 `auto_repair` 블록을 선언하고, SKILL.md 서술도 일치시켰으며, prose↔schema sync 테스트가 auto_lint 계약까지 커버합니다.

### 변경

- 동시성 lock trap 3패턴(단일 블록 무조건 해제 trap / 다중 블록 실패 전용 trap + 명시적 해제 / 경합 soft-fail)을 `storage-layout.md`에 문서화하고, invariant #3을 *what*(모든 write 전 획득, critical section 종료 전 해제)과 *how*(trap 형태 → 패턴 카탈로그)로 분리했습니다. 기존 스킬 trap 코드는 변경하지 않았습니다.
- `/wiki-lint --fix` version prune이 이제 백업을 숫자 버전으로 정렬하여 `.v10`/`.v11`이 `.v2`보다 올바르게 유지됩니다(lexicographic 정렬은 최신 백업을 삭제할 수 있었습니다).

## [1.7.0] — 2026-05-22 (대규모 위키 reader race 수정 + index.md dashboard + inbox 정리)

### 수정

- 대규모 위키(약 400+ 페이지)에서 index-envelope reader의 stdout flush race로 출력이 비결정적으로 truncation되어 duplicate page 생성이나 index merge 시 silent page loss가 발생할 수 있던 문제를 수정했습니다.

### 변경

- `index.md`를 매 ingest마다 전체 catalog를 재작성하는 방식(100페이지 이상에서 비현실적) 대신 가벼운 always-fresh dashboard(위키 overview, at-a-glance stats, recent activity, top tags, opt-in featured pages)로 재정의했습니다. 전체 machine-readable catalog는 `.wiki-meta/index.json`에 그대로 남습니다. dashboard는 `<!-- deep-wiki-dashboard-v1.7.0 -->`로 표시되며, pre-1.7.0 `index.md`는 첫 덮어쓰기 전에 `.wiki-meta/.backups/index.md.pre-1.7.0`으로 자동 백업됩니다.
- `/wiki-setup`이 이제 fresh wiki를 v1.7.0 dashboard 형식으로 seed합니다.

### 추가

- `/wiki-ingest`에 inbox stale-cleanup 단계를 추가했습니다: 미해결 `partial_fail` sentinel이 참조하지 않는 7일 이상 된 파일은 `.wiki-meta/.inbox/.quarantine/`로 이동(삭제가 아닌 quarantine)되어 crash된 세션의 소스를 복구할 수 있습니다.

## [1.6.2] — 2026-05-18 (Codex-native plugin manifest and AGENTS guide)

### 추가

- Claude Code manifest와 동일한 skill·hook 표면을 가리키는 Codex 네이티브 플러그인 manifest `.codex-plugin/plugin.json`을 추가했습니다.
- runtime surface와 검증을 다루는 Codex 프로젝트 가이드 `AGENTS.md`를 추가했습니다.

### 변경

- README가 기존 Claude Code 표면과 함께 Codex 호환성을 명시합니다.

## [1.6.1] — 2026-05-18 (Codex strict-YAML 파서를 위한 wiki-setup description 수정)

### 수정

- `wiki-setup` skill frontmatter description을 수정해 Codex의 strict YAML 파서가 더 이상 이를 거부하고 로드 시 skill을 silent drop하지 않도록 했습니다. `A:`/`B:` 콜론-스페이스 패턴을 `option A —`/`option B —`로 재작성하고 description을 quote 처리했으며, 내용은 그대로입니다.

## [1.6.0] — 2026-05-18 (5 슬래시 커맨드 → user-invocable skill: cross-platform)

### 변경

- 5개 `/wiki-*` 슬래시 커맨드를 모두 `skills/wiki-{setup,ingest,query,lint,rebuild}/SKILL.md`의 `user-invocable: true` 스킬로 승격하고 `commands/` 디렉토리를 제거했습니다. 각 스킬에 `## Invocation`, `## Inputs`, `## Prerequisites` head section이 추가됩니다. 커맨드 동작(ingest / query / lint / rebuild / setup 절차)은 변경되지 않습니다.

### 마이그레이션

- **Claude Code 사용자:** 변경 없음 — `/wiki-setup`, `/wiki-ingest`, `/wiki-lint`, `/wiki-query`, `/wiki-rebuild`와 SessionStart auto-ingest hook이 계속 작동하며, Claude Code가 스킬을 슬래시 커맨드로 auto-discover합니다.
- **Codex / Copilot CLI / Gemini CLI / Agent SDK 사용자:** `Skill({ skill: "deep-wiki:wiki-ingest", args: "<source>" })` 형태로 호출합니다. 인자 문법은 동일합니다.

## [1.5.3] — 2026-05-13 (메타데이터 — SKILL.md description 길이)

### 수정

- `wiki-schema` skill frontmatter description을 Claude Code 1024자 제한 아래로 축약했습니다 (초과로 로드 시 경고 발생). 모든 trigger 키워드는 보존됩니다. 메타데이터 전용 패치이며 동작 변경 없음.

## [1.5.2] — 2026-05-12

### 추가

- SessionStart scan hook의 `.pending-scan` 복구 통합 테스트를 추가해 인위적으로 손상된 state(invalid / valid / stale / empty / corrupt 내용)에 대해 동작을 고정했습니다. 테스트 전용 릴리스이며 동작 변경 없음.

## [1.5.1] — 2026-05-12

### 추가

- SessionStart auto-ingest scan hook의 golden-fixture 테스트 suite를 추가해 8개 시나리오 corpus(빈 vault, 새 파일, 제외 디렉토리, mtime 필터링, tag/glob 필터, config 없음)에 대해 감지 개수, 파일 목록, exit code, `.pending-scan` 보존을 고정했습니다. 테스트 전용 릴리스이며 동작 변경 없음.

## [1.5.0] — 2026-05-11 (M3 envelope 도입)

### 추가

- `<wiki_root>/.wiki-meta/index.json`이 이제 deep-suite M3 cross-plugin envelope 안으로 들어갑니다. 기존 `{pages, generated_at}` 구조는 `payload` 내부에 그대로 보존됩니다. 각 emit은 ULID `run_id`, producer attribution(`producer = "deep-wiki"`, `producer_version`), schema identity, git/tool-version provenance snapshot을 담아 cross-plugin trace와 schema-drift 감지를 가능하게 합니다.
- envelope-aware reader와 writer 헬퍼를 추가했습니다: reader는 (envelope-wrap 여부와 무관하게) stdout으로 legacy 구조를 emit하고, writer는 payload를 감싸 `index.json`에 atomic write합니다. identity guard가 foreign/corrupt envelope를 거부합니다.

### 호환성

- **Forward 호환:** reader가 legacy `{pages, generated_at}` 구조를 emit하므로 기존 `jq` pipeline(`.pages[].file`, `.generated_at`)이 그대로 작동합니다.
- **Backward 호환:** legacy `index.json` 파일은 그대로 통과합니다 — 업그레이드 후 `/wiki-rebuild`가 필요 없습니다. `/wiki-rebuild`(또는 다음 `/wiki-ingest`) 실행 시 데이터 손실 없이 index를 envelope 형태로 재포장합니다.
- mid-write 중단이 truncated `index.json`을 남길 수 없습니다 (atomic temp + rename). index 경로에 놓인 foreign-producer envelope는 거부되며, page frontmatter(source of truth)로부터 재생성하는 `/wiki-rebuild`로 복구합니다.

## [1.4.2] — 2026-05-07

### 수정

- truncated `existing_page_body`를 emit한 synthesizer 때문에 모든 page 업데이트가 abort되던 false-positive 동시성 abort를 수정했습니다. 이제 main 세션이 동시성 검사와 synthesis context의 authoritative baseline으로 page bytes를 disk에서 다시 읽습니다. drift가 감지되면 영향받은 page를 disk bytes로부터 재합성하고(loud-failure 속성을 유지하면서 retry 정확성 복구), 모든 page read 전에 basename-traversal guard를 적용합니다.
- 모든 update 항목이 drop된(invalid basename / 누락 page / read 실패) 경우 소스를 clean skip으로 promote하지 않도록 all-dropped ingest 경로를 수정했습니다; 이제 `partial_fail` retry sentinel을 작성하고 3-strike `ingest-fail` 복구에 참여합니다.
- worker-mutation dirty-scan을 single-source analysis dispatch에도 적용하도록 확장했습니다 (test-mode 전용; production cost 0).

### 추가

- per-phase 타이밍을 위해 `log.jsonl` `ingest` 라인에 `phase_timing_ms`(`stage_1_analysis`, `stage_2_fanout`, `stage_3_write`, `total`)를 추가했습니다. Schema-additive — non-`ingest` action에서는 생략되고 lint가 무시합니다.

### 마이그레이션

- v1.4.1로부터 외부 API 변경 없음. 동시성 검사 hash 값은 v1.4.1과 byte-identical하지 않지만, abort/success 결정은 spec-compliant agent에 대해 동등합니다.

## [1.4.1] — 2026-05-06 (synthesizer agent 분할 — trust-boundary closure)

### 변경

- 통합 `wiki-synthesizer` agent를 세 개의 role-scoped 파일로 분할했습니다 — `wiki-synthesizer-analysis`(single-source 분석)와 `wiki-synthesizer-worker`(multi-source worker + collision merge)는 모두 도구 선언에 **`Write` 없음**, 그리고 v1.3.0 inline 계약을 향후 복원용으로 보존하는 dormant `wiki-synthesizer-inline`. `/wiki-ingest`는 이제 이 agent들을 qualified namespace(`deep-wiki:<agent>`)로 dispatch합니다. 이는 worker가 general-purpose agent로 downgrade되어 Stage 3 lock 밖에서 write 권한을 부여받던 v1.4.0 failure mode를 닫습니다.

### 추가

- 향후 변경이 active agent에 `Write`를 다시 추가하면 실패하는 frontmatter lint(`scripts/lint-agent-tools.sh`)와, 각 agent dispatch 후 실행되는 test-mode-gated in-root dirty-file scan(production cost 0)을 추가했습니다.

### 제거

- 기존 통합 `wiki-synthesizer.md` agent를 제거했습니다 (compatibility shim 없음).

### 마이그레이션

- single-source와 multi-source ingest는 v1.4.0과 동일한 page, provenance, log event를 생성합니다 (byte-identical 아님). `subagent_type: "wiki-synthesizer"`를 직접 dispatch하던 외부 caller는 `deep-wiki:wiki-synthesizer-analysis`(single-source) 또는 `deep-wiki:wiki-synthesizer-worker`(multi-source / collision merge)로 전환해야 합니다; `/wiki-ingest` 자체는 본 릴리스에서 마이그레이션되었습니다.

### 알려진 제한

- trust-boundary closure는 agent-metadata 수준 + static lint + in-root runtime guard의 layered defense-in-depth이며, comprehensive enforcement는 아닙니다. in-root scan은 `<wiki_root>/` 내부 mutation만 커버하고 off-root write(예: `/tmp/`)는 커버하지 않습니다. process-level sandboxing은 차기 릴리스로 보류합니다.

## [1.4.0] — 2026-05-05 (A5 page-level fanout)

### 추가

- single-source `/wiki-ingest`가 이제 N개의 `wiki-page-writer` worker에 걸쳐 page-body 생성을 병렬화합니다. 새 analysis 단계가 생성/갱신할 page를 기술하는 `page_plan`을 emit하고(sub-threshold run에는 inline body 포함), fanout 단계가 page당 worker 하나를 dispatch하며(기본 threshold: 3 page), main 세션이 draft를 모아 lock 하에 mandatory 동시성 검사와 함께 atomic write합니다. Karpathy의 "소스당 10–15 page touch" 속성은 보존됩니다 — fanout은 *누가* page를 쓰는지를 바꿀 뿐, 몇 개를 쓰는지는 바꾸지 않습니다.
- `wiki-page-writer` agent를 추가했습니다 (file I/O 없음; main이 lock 하에 write 소유).
- fanout run에서 어떤 page라도 실패하면 작성되는 per-source provenance YAML의 `partial_fail` sentinel을 추가했습니다; 다음 세션은 소스 bytes가 변하지 않아도 repair를 강제하며, sentinel은 clean re-ingest 시 제거됩니다.
- `log.jsonl` `ingest` 라인에 `pages_failed` 필드를 추가했습니다.
- 같은 scan window에서 3회 연속 all-workers-fail batch 후 stuck window를 해제하기 위해 emit되는 `ingest-fail` lifecycle action을 추가했습니다.
- 선택적 `<wiki>/.wiki-meta/.config.json` 노브를 추가했습니다: `a5_fanout_threshold`(기본 3)와 `a5_worker_timeout_sec`(기본 90, advisory). 부재 시 기본값 — 마이그레이션 불필요.

### 마이그레이션

- single-source 의미는 보존되나 byte-identical하지 않습니다 (analysis-mode가 ~10–25% wall-clock variance 추가). multi-source 경로는 v1.3.0과 동일합니다. 모든 v1.2.0+/v1.3.0 불변식이 보존됩니다.

### 노트

- 초기 real-vault dogfood는 runtime의 관측된 ~3-concurrent-subagent cap 하에서 ~17분 wall-clock을 측정했습니다 (unbounded 병렬성을 가정한 원래 목표 ≤5분이 아님). 메커니즘은 설계대로 동작하며, per-stage 타이밍 특성화는 v1.4.2(`phase_timing_ms`)에서 도착했습니다.

## [1.3.0] — 2026-05-02

### 추가

- multi-source `/wiki-ingest`가 이제 최대 3개의 병렬 `wiki-synthesizer` worker(worker mode)에 걸쳐 fanout합니다. worker는 전체 LLM 분석을 하지만 file write는 하지 않으며, main 세션이 draft를 모아 기존 단일 lock 하에 모든 write를 순차 수행합니다. cross-worker page collision은 second-pass merge를 트리거해 multi-source merge 불변식을 보존합니다. 3+ 소스 batch의 예상 wall-clock 감소: ~30–50%.
- `ingest-fail` lifecycle action과 `.failed-sources.tsv` retry manifest, `.pending-scan-retry-count` 카운터를 추가해 multi-source batch의 3-strike stuck-window 복구를 가능하게 했습니다.

### 변경

- SessionStart hook의 `auto_ingest.ignore_globs` 파서가 이제 block, inline(`["a", "b"]`), dotted(`auto_ingest.ignore_globs: [...]`) 형식을 수용합니다; 동일 확장이 lint orphan-ignore 파서에도 적용됩니다. 이는 block-form list의 첫 항목 이후를 silent drop하던 latent bug도 수정합니다.

### 수정

- `/wiki-lint` broken-link 감지가 tab-indented code block 내부 링크를 더 이상 false-flag하지 않으며, 두 개의 blank line 이후 list-continuation 상태를 올바르게 reset합니다 (CommonMark).

### 마이그레이션

- single-source `/wiki-ingest`는 v1.2.1과 byte-identical합니다. multi-source는 cross-worker collision이 없으면 동일한 final state를 생성하며, wall-clock만 변합니다. 기존 `auto_ingest:` block-form config는 그대로 작동합니다.

### 트레이드오프

- multi-source fanout은 최대 3 worker를 병렬 dispatch하며 각각 synthesizer spec을 로드합니다 (3-소스 batch에서 ~2–3× spec context cost); global lock은 multi-source 경로에서 전체 분석 동안 유지됩니다. single-source는 영향받지 않습니다.

## [1.2.1] — 2026-05-02

### 수정

- 두 file 소스가 basename을 공유할 때 slug collision을 disambiguate하여, 우연한 hash 일치 시의 silent cross-attribution 위험을 닫았습니다.
- `log.jsonl`이 부재하거나 provenance YAML이 있는데도 slug에 terminal log entry가 없을 때 `ingest-repair`를 강제합니다. (log truncation으로 트리거되면 repair 라인이 `pages_created:[]`를 emit하며, per-source YAML이 authoritative provenance 기록으로 남습니다.)
- `.md`로 끝나는 `http(s)://` 타깃을 `/wiki-lint` broken-link 감지에서 제외하여 외부 URL의 false positive를 제거했습니다.
- `/wiki-lint` code-block 스트리핑을 block-context-aware로 만들어 실제 indented code는 스트립하되 list item 내부 링크는 감지 대상으로 유지합니다.
- 두 소스가 한 batch에서 같은 page를 독립적으로 생성할 때 per-source attribution을 보존(두 기여 slug 모두 기록)하면서 intra-batch dedup으로 log 불변식을 유지합니다.

### 변경

- README cloud-mirror 가이드가 이제 vault가 아닌 로컬 `wiki_root`는 SessionStart hook이 `$HOME`을 감시하게 만든다고 경고하며, `auto_ingest:` 블록 제거가 auto-ingest를 중단하지 않는다는 점을 바로잡습니다 (대신 `ignore_globs: ['**']`를 설정하거나 hook을 비활성화).

## [1.2.0] — 2026-04-30

### 추가

- config에 선택적 `auto_ingest` 블록(`ignore_globs`, `require_tag`)을 추가해 SessionStart hook이 `/wiki-ingest` 호출 전에 high-volume·low-value 경로를 필터링할 수 있게 했습니다. backward 호환 — 부재 시 기존 동작 유지.
- re-ingest hash skip을 추가했습니다: `/wiki-ingest`가 각 소스의 sha256을 저장된 `content_hash`와 비교해 변하지 않은 소스를 lock 획득 전에 drop하며, 새 `ingest-skip` log action을 기록합니다. hash 일치만으로는 불충분 — wiki-side state integrity도 검증하며, 실패 시 새 `ingest-repair` action으로 기록되는 normal ingest로 fall-through합니다.
- README에 cloud-storage mirror-and-sync 워크플로우를 문서화했습니다 (`wiki_root`를 로컬 디스크에; vault로 스케줄 additive rsync; 다른 기기에서 편집 전 수동 reverse-rsync).

### 변경

- synthesizer 후보 필터링이 이제 frontmatter로 점수를 매기고 상위 몇 개 후보를 deep-read하며 나머지를 parallel Grep batch로 검증합니다 — 첫 dogfood에서 측정 ~20% per-page wall-clock 감소.
- `/wiki-lint`가 `[SCAN-WINDOW]` 불변식 검사(invalid timestamp, `PENDING < LAST` regression, stalled auto-ingest)를 portable tri-branch date parsing과 함께 추가합니다; `--fix`는 stale/invalid `.pending-scan`을 drop하고 >48h 경우는 수동 판단이 필요합니다.
- `/wiki-lint` `[ORPHAN]` 분류가 이제 `leaf` 태그 page와 구성된 `lint.orphan_ignore` glob에 매칭되는 page를 제외합니다.
- `/wiki-lint` `[BROKEN]` 감지가 `.md` 링크 패턴을 스캔하기 전에 fenced code block을 스트립합니다.
- `/wiki-ingest`가 within-batch duplicate page create를 reclassify하여 첫 번째만 created로 세고, 새 ingest의 "exactly once across log" 불변식을 복원합니다.

### 마이그레이션

- 조치 불필요. perf gain을 opt-in하려면 `auto_ingest:` 블록을 추가하고, `/wiki-lint --fix`를 한 번 실행해 stale `.pending-scan`을 정리하고 excess version backup을 prune하며, 선택적으로 `wiki_root`를 로컬 디스크로 옮기세요.

## [1.1.4] — 2026-04-24

### 수정

- `content_hash`가 이제 `^[0-9a-f]{64}$`로 검증되고 synthesizer가 non-hex sentinel을 반환하면 소스로부터 재계산되어, re-ingest 감지와 provenance 감사가 다시 신뢰할 수 있게 되었습니다 (v1.1.2 이후 불안정했음).
- stale pending 파일이 남아있을 때 `.pending-scan → .last-scan` promotion이 더 이상 `.last-scan`을 뒤로 이동시키지 않아, 다음 hook 실행 시 duplicate `log.jsonl` entry를 방지합니다.

### 마이그레이션

- 조치 불필요. placeholder `content_hash` 값을 가진 기존 `sources/<slug>.yaml`은 historical 기록으로 남으며, 재-ingest 시 유효한 digest를 생성합니다.

## [1.1.3] — 2026-04-24

### 변경

- `wiki-synthesizer` agent가 이제 각 워크플로우 phase(source read / candidate survey / backup batch / page write) 내에서 도구 호출을 병렬로 발행해 multi-page ingest의 wall-clock을 줄입니다. 순수 prompt 변경 — contract, schema, lock/provenance 동작 변경 없음.

### 노트

- README가 cloud-synced `wiki_root`가 per-write 지연세(각 write가 sync daemon을 깨움)를 추가한다고 문서화합니다; 권장은 `wiki_root`를 로컬 디스크에 두는 것입니다.

## [1.1.2] — 2026-04-21

### 변경

- `/wiki-ingest`가 이제 항상 page I/O를 `wiki-synthesizer` subagent에 위임하여(이전에는 대부분 inline), main 세션에 작은 메타데이터 footprint만 남기고 SessionStart auto-ingest의 context 압박을 크게 줄입니다.
- version backup(`.versions/`로의 pre-overwrite snapshot)을 synthesizer로 이동했습니다; retention pruning은 auto-lint에 남습니다.
- agent 입출력 계약이 이제 formal/structured입니다: `{file, title, tags, aliases, sources}`를 가진 `created`/`updated` 항목과 `versioned`, `source_hashes`, `failed`를 반환합니다. caller가 각 보고된 write를 실제 파일시스템 state와 reconcile하고 filename을 검증하며 `pages_created` vs `pages_updated`에 대해 authoritative합니다.
- `index.json` 업데이트가 manifest frontmatter를 직접 사용합니다 (page 재읽기 없음); multi-source batch의 per-source provenance가 이제 inferred가 아니라 authoritative입니다; `content_hash`는 agent가 fetch/read 시점에 계산합니다.
- pasted-text ingest는 dispatch 전에 `.inbox/` 파일로 materialize됩니다 (lock 해제와 함께 삭제). overlap 감지가 candidate hint 너머로 검색을 넓히도록 강화되며, post-write reconciliation이 보고됐지만 누락된 파일을 `failed`로 이동합니다.
- `--synthesize` 플래그가 no-op hint로 demote되었습니다 (synthesis가 이제 기본); agent의 도구 범위가 `type: url` 소스를 위한 `WebFetch`를 얻습니다.

### 마이그레이션

- 조치 불필요. 주요 관측 가능한 변화는 ingest 동안 context 사용 감소와 multi-source batch의 올바른 per-source provenance입니다.

## [1.1.1] — 2026-04-17

### 보안

- `.gitignore`가 이제 다른 기여자에게 전파되면 안 되는 repo-scoped 권한을 부여할 수 있는 `.claude/settings.local.json`과 `.claude/.sensor-detection-cache.json`을 커버합니다.
- 업그레이드 문서의 파괴적 `git rm --cached -r . && git reset --hard` 가이드를 안전한 `git add --renormalize` 흐름으로 교체했습니다.

### 수정

- 감지된 파일 배열이 비어있을 때 SessionStart hook이 macOS bash 3.2에서 더 이상 crash하지 않습니다.
- hook이 detected-at timestamp를 `.pending-scan`에 atomic하게 작성하며, `/wiki-ingest`는 성공적인 batch 후에만 pending → committed를 promote하므로, 동시 hook 실행이 실제 ingest된 것 너머로 `.last-scan`을 advance할 수 없습니다.
- 위키가 vault root에 있을 때(`wiki_prefix: "."`) hook이 위키 artifact를 스캔에서 제외하여 위키가 자기 자신을 ingest할 수 없습니다.
- YAML config 파싱이 이제 block 경계를 존중합니다 (인접한 `available: true`가 더 이상 `obsidian_cli`로 mis-attribute되지 않음).
- 모든 커맨드가 이제 `Z` suffix가 있는 UTC ISO 8601 timestamp를 요구합니다; historical `+09:00` entry는 그대로 읽힙니다.
- `[LOG-INVARIANT]` lint 검사가 duplicate `pages_created` entry를 보고합니다; filename은 log 전체에서 `pages_created`에 최대 한 번 나타납니다.

### 변경

- Windows가 Git Bash 또는 WSL2를 요구하는 Experimental로 문서화되었습니다 (hook은 네이티브 `cmd.exe`/PowerShell 미지원). Windows 네이티브 `wiki_root` 경로는 친절한 POSIX-form 힌트와 함께 거부되고; `timeout.exe`가 감지·skip되며(`gtimeout` 또는 no timeout으로 fallback); `.gitattributes`가 LF endings를 강제하고; README가 Google Drive mount 관례, NTFS 대소문자 비구분, long-path 지원을 문서화합니다.

### 비고

- 모든 변경은 backward 호환입니다. `.pending-scan`은 additive이며; mixed-timezone log entry는 그대로 읽힙니다 (새 entry만 UTC 요구).

## [1.1.0] — 2026-04-08

### 추가

- Obsidian CLI 통합 — 위키가 vault 안에 있을 때 `/wiki-setup`이 Obsidian CLI를 자동 감지하며, 이후 위키 커맨드가 더 정확한 결과를 위해 Obsidian의 full-text 검색, backlink 그래프, orphan 감지, unresolved-link 추적을 사용합니다.
- `/wiki-query`가 graph-based query expansion을 추가합니다 (backlink를 따라 관련 page 발견; Obsidian CLI 전용).
- SessionStart 스캔이 `find`를 `obsidian recents`로 보완합니다 (union + dedupe, mtime 검증 포함).

### 변경

- config schema가 선택적 `obsidian_cli` 블록을 얻습니다; 부재 시 filesystem-only 모드 (완전 backward 호환).
- `/wiki-setup` 재실행이 re-detection 전에 stale `obsidian_cli` config를 제거합니다.
- SessionStart hook이 GNU coreutils를 가정하는 대신 `timeout`/`gtimeout` 가용성을 감지합니다.

### 설계 원칙

- Progressive enhancement: Obsidian CLI는 filesystem 동작을 향상시키되 대체하지 않으며, 모든 vault-wide CLI 결과는 위키 경계로 필터링됩니다. write는 filesystem 기반으로 유지됩니다.

## [1.0.1] — 2026-04-07

### 추가

- 자동 ingest SessionStart hook — Claude Code 세션 시작 시 Obsidian vault의 새로운/수정된 파일을 자동 감지하고 위키에 ingest. 수동 작업 불필요.
- 일괄 ingest 지원 — `/wiki-ingest`가 auto-ingest hook의 다중 파일을 일괄 처리 지원. 단일 lock, 그룹별 로그 기록.

## [1.0.0] — 2026-04-07

### 마일스톤

첫 번째 안정 릴리스. Karpathy의 LLM Wiki 글에서 제시한 모든 핵심 기능이 구현되었으며, 실제 Obsidian vault 마이그레이션(700+ 파일 → 107개 위키 페이지)을 통해 시스템이 검증되었습니다.

### 추가 (0.2.0 이후)

- 실전 검증 — PARA 구조의 Obsidian vault 전체를 deep-wiki로 마이그레이션하여 대규모 운영 가능성을 입증.

## [0.2.0] — 2026-04-07

### 추가

- **Query 자동 환류** — `/wiki-query`가 2개 이상의 페이지에서 교차 합성 인사이트를 생성하면, 결과가 자동으로 `query-synthesis` 페이지로 위키에 저장됩니다. 가치 있는 쿼리 결과가 지식 베이스에 복리로 쌓여야 한다는 Karpathy의 원칙을 구현합니다.
- **쓰기 작업 후 자동 lint** — `/wiki-ingest`와 `/wiki-rebuild` 후 lint 검사가 자동 실행됩니다. 구조적 문제(인덱스 불일치, 초과 버전)는 자동 수정하고, 사람의 판단이 필요한 문제만 보고합니다. 사용자가 lint를 기억할 필요가 없습니다.
- **`/wiki-setup`에서 추천 도구 확인** — 설정 시 CLI 도구(qmd, marp)와 Obsidian 플러그인(Dataview, Marp Slides, Web Clipper)의 설치 여부를 확인하고 설치 명령어를 안내합니다.
- **`recommended-tools.md` 참조 문서** — qmd, Marp, Dataview, Marp Slides, Obsidian Web Clipper 상세 가이드.
- **`wiki-schema.yaml`에 `recommended_tools`, `auto_lint` 스키마 정의** 추가.
- **CHANGELOG.md / CHANGELOG.ko.md** — 이 파일.

### 수정

- **`wiki-lint.md` 단계 번호 오류** — 8, 8, 10, 10이 8, 9, 10, 11로 수정됨.

### 변경

- `/wiki-query`가 더 이상 읽기 전용이 아닙니다. 교차 페이지 인사이트가 감지되면 자동으로 합성 페이지를 작성합니다.
- `/wiki-ingest`에 자동 lint 단계(Step 13) 추가. 최종 리포트 전에 실행됩니다.
- `/wiki-rebuild`에 자동 lint 단계(Step 5) 추가. 리포트 전에 실행됩니다.
- `wiki-schema` 스킬에 Auto-Lint, Query Auto-Filing 섹션 추가.
- `wiki-schema.yaml`에 `auto_lint`, `query_auto_filing`, `log.actions` 정의 추가.
- README(EN/KO)에 추천 도구 섹션, Obsidian 자동 체크 설명, 명령어 설명 갱신.

## [0.1.0] — 2026-04-06

### 추가

- Karpathy의 LLM Wiki 철학을 구현한 초기 릴리스.
- 5개 명령어: `/wiki-setup`, `/wiki-ingest`, `/wiki-query`, `/wiki-lint`, `/wiki-rebuild`.
- 다중 소스 합성을 위한 `wiki-synthesizer` 에이전트.
- 페이지 템플릿, 스키마 YAML, 저장소 레이아웃 참조를 포함한 `wiki-schema` 스킬.
- 콘텐츠 해싱을 통한 소스 출처 추적.
- `mkdir` 기반 동시성 잠금 프로토콜.
- 페이지 버전 관리 (최근 3개 유지).
- 이중 아티팩트: 사람이 읽는 용도(`index.md`, `log.md`) + 머신 리더블(`index.json`, `log.jsonl`).
- Obsidian 볼트 호환성.
- deep-work 세션 리포트 연동.
- 예시 페이지를 포함한 테스트 위키.
- 이중 언어 문서화 (EN/KO).
