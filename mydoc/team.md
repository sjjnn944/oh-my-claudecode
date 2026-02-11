# Team 동작 구조

## 개요

Team은 **Claude Code 네이티브 인프라 기반의 멀티 에이전트 조율 시스템**이다. 레거시 `/swarm`(SQLite 기반)을 대체하며, 외부 의존성 없이 파일 기반 조율로 동작한다.

- **트리거:** `/team N:agent-type 작업설명`
- **스킬 정의:** `skills/team/SKILL.md`
- **소스:** `src/team/` (25개 TypeScript 모듈)
- **상태 파일:** `.omc/state/team-state.json`

### 핵심 특징

- Claude Code 네이티브 도구 사용 (`TeamCreate`, `TaskCreate`, `SendMessage`, `TaskList` 등)
- 하이브리드 워커 지원 (Claude 에이전트 + MCP Codex/Gemini 워커)
- 커널 레벨 `O_EXCL` 파일 락으로 원자적 태스크 클레이밍
- 인터-에이전트 메시징, 하트비트, 헬스 모니터링

---

## 아키텍처 개요

```
┌─────────────────────────────────────────────────┐
│  User: "/team 3:executor fix all TS errors"     │
└─────────────────────────────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────┐
        │   TEAM ORCHESTRATOR (Lead)    │
        │   - 입력 파싱/검증             │
        │   - 태스크 분해                │
        │   - 팀 & 태스크 그래프 생성     │
        │   - 워커 스폰                  │
        │   - 진행 모니터링              │
        │   - 셧다운 관리                │
        └───────────┬───────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌─────────────────┐   ┌──────────────────┐
│  CLAUDE NATIVE  │   │  MCP WORKERS     │
│  TEAMMATES      │   │  (Codex/Gemini)  │
│                 │   │                  │
│ - TaskList 조회  │   │ - tmux 세션 실행  │
│ - 태스크 클레이밍 │   │ - CLI 자율 실행   │
│ - SendMessage   │   │ - 파일 기반 I/O   │
│ - 작업 실행      │   │ - inbox/outbox    │
└─────────────────┘   └──────────────────┘
        │                       │
        └───────────┬───────────┘
                    ▼
    ┌─────────────────────────────────┐
    │  SHARED COORDINATION LAYER      │
    │                                 │
    │  ~/.claude/teams/{team}/        │
    │    config.json   (팀 멤버 등록)  │
    │    inbox/        (리드→워커)     │
    │    outbox/       (워커→리드)     │
    │    signals/      (셧다운/드레인)  │
    │  ~/.claude/tasks/{team}/        │
    │    {id}.json     (태스크 파일)    │
    │    {id}.lock     (원자적 락)     │
    │                                 │
    │  {workdir}/.omc/state/          │
    │    team-state.json              │
    │    team-bridge/{team}/          │
    │      {worker}.heartbeat.json    │
    └─────────────────────────────────┘
```

---

## 워커 타입 비교

| 항목 | Claude Native | MCP Codex | MCP Gemini |
|------|--------------|-----------|------------|
| **백엔드** | `claude-native` | `mcp-codex` | `mcp-gemini` |
| **역량** | code-edit, testing, general | code-review, security, architecture | ui-design, docs, research |
| **모델** | (상속) | gpt-5.3-codex | gemini-3-pro-preview |
| **스폰** | `Task(team_name=...)` | `ask_codex --yolo` | `ask_gemini --yolo` |
| **통신** | `SendMessage` (네이티브) | inbox/outbox JSONL | inbox/outbox JSONL |
| **실행 환경** | Claude Code 에이전트 | tmux 세션 | tmux 세션 |

---

## 실행 스테이지 (Staged Pipeline)

```
team-plan → team-prd → team-exec → team-verify → team-fix (루프) → complete/failed/cancelled
```

### team-plan (계획)
- 입력 파싱, 코드베이스 분석, N개 서브태스크로 분해
- 태스크 의존성 그래프 정의

### team-prd (요구사항 정의, 선택적)
- 모호한 요구사항일 때만 실행
- 수용 기준 명확화

### team-exec (실행)
- `TeamCreate` → `TaskCreate × N` → 소유자 사전 배정 → 워커 스폰
- 워커들이 병렬로 태스크 클레이밍 및 실행
- 리드가 `TaskList` + 메시지로 진행 모니터링

### team-verify (검증)
- 모든 태스크 완료 후 검증 게이트 실행
- `tsc --noEmit`, `npm test`, `npm run lint` 등

### team-fix (수정 루프)
- 검증 실패 시 수정 태스크 생성
- 수정 → 재실행 → 재검증 (최대 3사이클)

---

## 태스크 라이프사이클

### 태스크 파일 구조 (`~/.claude/tasks/{team}/{id}.json`)

```json
{
  "id": "1",
  "subject": "Fix type errors in src/auth/",
  "description": "...",
  "status": "pending | in_progress | completed",
  "owner": "worker-1",
  "blocks": ["3", "4"],
  "blockedBy": ["2"],
  "metadata": {
    "permanentlyFailed": false,
    "failedAttempts": 0
  }
}
```

### 원자적 클레이밍 (Atomic Claiming)

```
1. 리드가 사전 배정: TaskUpdate(taskId, owner="worker-1")
2. 워커가 O_EXCL 락 획득: {id}.lock 파일 생성 (커널 보장)
   → 하나의 프로세스만 성공
3. 락 내부에서 상태 변경: pending → in_progress
4. 스테일 락 정리: 30초 이상 + PID 사망 → 재사용
```

### 의존성 해소

- `blockedBy: ["1", "2"]` → 태스크 #1, #2가 모두 `completed`여야 클레이밍 가능
- `areBlockersResolved()` 함수로 의존성 확인

### 실패 처리

```
태스크 실행 실패
    │
    ▼
실패 사이드카 기록: {id}.failure.json (retryCount, lastError)
    │
    ├─ 재시도 가능 (retryCount < 5) → pending으로 복귀
    │
    └─ 재시도 소진 → completed + permanentlyFailed=true
```

---

## 통신 메커니즘

### Claude Native 경로

```
리드 → SendMessage(recipient="worker-1", content="...") → 워커 수신
워커 → SendMessage(recipient="team-lead", content="...") → 리드 자동 수신
```

메시지는 **자동 배달** — 별도의 폴링 불필요.

### MCP Worker 경로

```
리드 → ~/.claude/teams/{team}/inbox/{worker}.jsonl 에 쓰기
워커 브릿지 → inbox 읽기 (바이트 오프셋 커서)
              → 태스크 처리
              → outbox/{worker}.jsonl 에 결과 쓰기
리드 → outbox 읽기 (바이트 오프셋 커서)
```

### 메시지 타입 (MCP 워커)

| 타입 | 방향 | 설명 |
|------|------|------|
| `task_complete` | 워커→리드 | 태스크 성공, 요약 포함 |
| `task_failed` | 워커→리드 | 태스크 실패, 에러 포함 |
| `idle` | 워커→리드 | 배정된 태스크 없음 |
| `heartbeat` | 워커→리드 | 주기적 헬스 펄스 |
| `shutdown_ack` | 워커→리드 | 셧다운 승인 |
| `error` | 워커→리드 | 복구 불가 에러 |

---

## 하트비트 & 헬스 모니터링

### 하트비트 파일 (`{worker}.heartbeat.json`)

```json
{
  "workerName": "worker-1",
  "teamName": "fix-ts-errors",
  "provider": "codex",
  "pid": 12345,
  "lastPollAt": "2026-02-07T12:00:00Z",
  "currentTaskId": "3",
  "consecutiveErrors": 0,
  "status": "polling | executing | shutdown | quarantined"
}
```

### 헬스 체크 판정

| 상태 | 조건 | 조치 |
|------|------|------|
| **Dead** | 하트비트 없음 + tmux 세션 없음 | 태스크 재배정, 교체 워커 스폰 |
| **Hung** | 하트비트 스테일 + tmux 생존 | 워커 재시작 고려 |
| **Quarantined** | `consecutiveErrors ≥ 3` | 태스크 처리 중단, 리드 개입 대기 |
| **At-risk** | `consecutiveErrors ≥ 2` | 경고, 모니터링 강화 |

---

## 태스크 라우팅 & 역량 매칭

### 역량 태그

| 백엔드 | 역량 |
|--------|------|
| `claude-native` | `code-edit`, `testing`, `general` |
| `mcp-codex` | `code-review`, `security-review`, `architecture`, `refactoring` |
| `mcp-gemini` | `ui-design`, `documentation`, `research`, `code-edit` |

### 피트니스 스코어링

```
점수 = (매칭 역량 × 1.0 + general 와일드카드 × 0.5) / 전체 필요 역량
      - 진행 중 태스크 × 0.2 (로드 페널티)
      + idle 보너스 0.1
```

---

## Git Worktree 격리

MCP 워커는 **격리된 Git 워크트리**에서 작업하여 파일 충돌을 방지한다.

```
{repoRoot}/.omc/worktrees/{team}/{worker}/
브랜치: omc-team/{teamName}/{workerName}
```

- **생성:** `createWorkerWorktree()` — 스테일 정리 후 새 워크트리/브랜치 생성
- **머지:** `mergeWorkerBranch()` — 충돌 체크 후 `--no-ff` 머지
- **정리:** `cleanupTeamWorktrees()` — 팀 셧다운 시 전체 제거

---

## 셧다운 프로토콜

```
리드: SendMessage(type="shutdown_request") → 모든 워커에게
    │
    ▼
워커: 현재 태스크 완료 → shutdown_response(approve=true)
    │
    ▼
리드: TeamDelete("fix-ts-errors")
    → ~/.claude/teams/{team}/ 삭제
    → ~/.claude/tasks/{team}/ 삭제
    → .omc/state/team-state.json 삭제
```

**드레인 셧다운** (우아한 종료):
- `drain` 시그널 파일 생성 → 현재 태스크만 완료 후 종료
- 새 태스크는 클레이밍하지 않음

---

## 전체 실행 흐름 예시

```
User: "/team 3:executor fix all TypeScript errors"
    │
    ▼
┌─ PARSE ──────────────────────────────┐
│ N=3, agent-type=executor             │
│ task="fix all TypeScript errors"     │
└──────────────┬───────────────────────┘
               ▼
┌─ DECOMPOSE ──────────────────────────┐
│ Task #1: src/auth/ 타입 에러 수정     │
│ Task #2: src/api/ 타입 에러 수정      │
│   └─ blockedBy: [#1]                 │
│ Task #3: src/utils/ 타입 에러 수정    │
│   └─ blockedBy: [#1]                 │
└──────────────┬───────────────────────┘
               ▼
┌─ TeamCreate("fix-ts-errors") ────────┐
│ TaskCreate × 3                       │
│ TaskUpdate × 3 (사전 소유자 배정)      │
│ Task × 3 (워커 스폰, 병렬)            │
└──────────────┬───────────────────────┘
               ▼
┌─ EXECUTION ──────────────────────────┐
│ Worker-1: Task #1 클레이밍 → 작업     │
│ Worker-2: (대기 — #1에 의해 블록됨)    │
│ Worker-3: (대기 — #1에 의해 블록됨)    │
│                                      │
│ Worker-1: #1 완료 → SendMessage      │
│ Worker-2: #2 언블록 → 클레이밍 → 작업  │
│ Worker-3: #3 언블록 → 클레이밍 → 작업  │
│                                      │
│ Worker-2: #2 완료 → SendMessage      │
│ Worker-3: #3 완료 → SendMessage      │
└──────────────┬───────────────────────┘
               ▼
┌─ VERIFY ─────────────────────────────┐
│ tsc --noEmit ✓                       │
│ npm test ✓                           │
│ npm run lint ✓                       │
└──────────────┬───────────────────────┘
               ▼
┌─ SHUTDOWN ───────────────────────────┐
│ shutdown_request × 3 → 응답 대기      │
│ TeamDelete → 정리                     │
└──────────────┬───────────────────────┘
               ▼
         TEAM COMPLETE
```

---

## Team vs Swarm (레거시) 비교

| 측면 | Team (Native) | Swarm (SQLite) |
|------|--------------|----------------|
| **저장소** | JSON 파일 | SQLite DB |
| **외부 의존성** | 없음 | better-sqlite3 |
| **태스크 클레이밍** | O_EXCL 파일 락 | SQLite 트랜잭션 |
| **통신** | SendMessage (DM, broadcast) | 없음 (fire-and-forget) |
| **태스크 의존성** | blocks/blockedBy 지원 | 미지원 |
| **셧다운** | 우아한 request/response | 시그널 기반 |
| **MCP 워커** | 하이브리드 지원 | 미지원 |
| **충돌 방지** | 소유자 사전 배정 | 리스 기반 (5분 타임아웃) |

---

## 주요 주의사항

1. **태스크 ID는 문자열** — `"1"`, `"2"` (정수 아님)
2. **TeamDelete 전 셧다운 필수** — 모든 워커 종료 후에만 삭제 가능
3. **broadcast는 고비용** — N명에게 각각 별도 메시지 전송, 꼭 필요할 때만 사용
4. **MCP 워커는 일방향** — TaskList/SendMessage 사용 불가, 리드가 라이프사이클 전체 관리
5. **내부 태스크 필터링** — `metadata._internal=true` 태스크는 진행률 계산에서 제외

---

## 관련 소스 파일

| 파일 | 역할 |
|------|------|
| `skills/team/SKILL.md` | 스킬 정의 (전체 워크플로우) |
| `commands/team.md` | 명령 템플릿 |
| `src/team/task-manager.ts` | 태스크 CRUD, 원자적 클레이밍, 의존성 해소 |
| `src/team/worker-manager.ts` | 워커 등록, 헬스 리포트, 역량 매칭 |
| `src/team/message-router.ts` | inbox/outbox 기반 메시지 라우팅 |
| `src/team/mcp-team-bridge.ts` | MCP 워커 브릿지 데몬 (폴링 루프) |
| `src/team/bridge-entry.ts` | 브릿지 엔트리포인트 (tmux 세션에서 실행) |
| `src/team/git-worktree.ts` | Git 워크트리 생성/머지/정리 |
| `src/team/task-router.ts` | 피트니스 스코어링, 태스크 라우팅 |
| `src/team/types.ts` | 타입 정의 |
