# Autopilot 파이프라인 및 동작 구조

## 개요

Autopilot은 **간단한 아이디어 → 완성된 코드**까지 자율 실행하는 5단계 파이프라인이다.

- **트리거 키워드:** `autopilot`, `auto pilot`, `autonomous`, `build me`, `create me`, `make me`, `full auto`, `handle it all`, `I want a/an...`
- **스킬 정의:** `skills/autopilot/SKILL.md`
- **상태 파일:** `.omc/state/autopilot-state.json`

---

## 전체 파이프라인 흐름

```
사용자 입력 ("autopilot", "build me", "make me" 등 매직 키워드)
    │
    ▼
┌─ Phase 0: EXPANSION ──────────────────────┐
│  Analyst (Opus) → 요구사항 추출            │
│  Architect (Opus) → 기술 스펙 생성         │
│  산출물: .omc/autopilot/spec.md            │
│  시그널: EXPANSION_COMPLETE                │
└───────────────┬───────────────────────────┘
                ▼
┌─ Phase 1: PLANNING ───────────────────────┐
│  Architect (Opus) → 구현 계획 생성         │
│  Critic (Opus) → 계획 검증 (최대 5회 반복)  │
│  산출물: .omc/plans/autopilot-impl.md      │
│  시그널: PLANNING_COMPLETE                 │
└───────────────┬───────────────────────────┘
                ▼
┌─ Phase 2: EXECUTION (Ralph + Ultrawork) ──┐
│  Executor-Low (Haiku) → 단순 작업          │
│  Executor (Sonnet) → 표준 작업             │
│  Executor-High (Opus) → 복잡한 멀티파일 작업 │
│  병렬 실행, TODO 리스트로 진행 추적          │
│  시그널: EXECUTION_COMPLETE                │
└───────────────┬───────────────────────────┘
                ▼
        [상태 전환: Ralph→UltraQA]
        Ralph/Ultrawork 상태 정리
                ▼
┌─ Phase 3: QA (UltraQA) ──────────────────┐
│  Build → Lint → Test 반복 (최대 5사이클)   │
│  실패 시: Architect-Low 진단 + Build-Fixer 수정 │
│  같은 에러 3회 반복 시 중단                 │
│  시그널: QA_COMPLETE                       │
└───────────────┬───────────────────────────┘
                ▼
        [상태 전환: UltraQA→Validation]
                ▼
┌─ Phase 4: VALIDATION ─────────────────────┐
│  3개 Architect 병렬 실행:                   │
│  ① Functional → 기능 완전성 검증            │
│  ② Security → 보안 취약점 검사              │
│  ③ Quality → 코드 품질/유지보수성 검토       │
│  3개 모두 APPROVED 필요 (최대 3라운드)       │
│  시그널: AUTOPILOT_COMPLETE                │
└───────────────┬───────────────────────────┘
                ▼
┌─ Phase 5: CLEANUP ────────────────────────┐
│  상태 파일 삭제, /cancel 실행               │
│  성공 요약 출력                             │
└───────────────────────────────────────────┘
```

---

## 핵심 동작 메커니즘: Self-Loop (자기 반복)

Autopilot의 핵심은 **persistent-mode 훅을 통한 self-loop**이다.

```
Claude 응답 종료 (Stop 이벤트)
    │
    ▼
persistent-mode 훅이 checkAutopilot() 호출
    │
    ├─ 시그널 미감지 → shouldBlock: true
    │   → 현재 페이즈 계속 작업하라는 프롬프트 재주입
    │   → Claude가 다시 작업 (루프)
    │
    └─ 시그널 감지 (예: EXPANSION_COMPLETE)
        → 다음 페이즈로 전환
        → 다음 페이즈 프롬프트 주입
        → Claude가 새 페이즈 시작
```

시그널은 세션 트랜스크립트에서 정규식으로 감지된다 (`/EXPANSION_COMPLETE/i` 등).

---

## 5개 페이즈 상세

### Phase 0: Expansion (요구사항 → 스펙)

- **Analyst (Opus):** 기능적/비기능적/암시적 요구사항 추출
- **Architect (Opus):** 기술 스택, 아키텍처, 파일 구조가 포함된 기술 스펙 생성
- **산출물:** `.omc/autopilot/spec.md`

### Phase 1: Planning (스펙 → 구현 계획)

- **Architect (Opus):** 스펙 기반 상세 구현 계획 생성 (인터뷰 없이 직접 생성)
- **Critic (Opus):** 계획 완전성 및 품질 검증
- **반복:** Critic이 거부하면 최대 5회 반복
- **산출물:** `.omc/plans/autopilot-impl.md`

### Phase 2: Execution (계획 → 코드)

- **Ralph + Ultrawork** 모드로 실행
- 3 티어 Executor로 병렬 작업:
  - **Executor-Low (Haiku):** 단순/단일 파일 작업
  - **Executor (Sonnet):** 표준 기능 구현
  - **Executor-High (Opus):** 복잡한 멀티파일 작업

### Phase 3: QA (코드 → 검증된 빌드)

- **UltraQA 모드:** Build → Lint → Test 사이클 반복
- 최대 5사이클; 같은 에러 3회 반복 시 조기 중단
- 실패 시 Architect-Low(Haiku)가 진단, Build-Fixer(Sonnet)가 수정

### Phase 4: Validation (코드 → 승인)

- 3개 Architect 병렬 검토:
  - **Functional:** 모든 요구사항이 구현되었는지 확인
  - **Security:** 보안 취약점 평가
  - **Quality:** 코드 품질 및 유지보수성 검토
- 3개 모두 APPROVED 필요; 거부 시 수정 후 재검증 (최대 3라운드)

---

## 에이전트 모델 티어 배분

| 티어 | 모델 | 사용처 |
|------|------|--------|
| **Opus** | 고비용/고품질 | Analyst, Architect, Critic, Security-Reviewer, Code-Reviewer |
| **Sonnet** | 표준 | Executor, Build-Fixer |
| **Haiku** | 저비용/빠름 | Executor-Low, Architect-Low (진단용) |

---

## 상태 관리

| 항목 | 설명 |
|------|------|
| **상태 파일** | `.omc/state/autopilot-state.json` |
| **세션 격리** | `session_id`로 다른 세션과 격리 |
| **상호 배제** | `canStartMode('autopilot')`로 다른 모드와 충돌 방지 |
| **안전 장치** | `max_iterations: 10` (무한 루프 방지) |
| **취소/재개** | 취소 시 상태 보존 → 나중에 재개 가능 |

### 상태 구조 (AutopilotState)

```typescript
{
  active: boolean,
  phase: 'expansion' | 'planning' | 'execution' | 'qa' | 'validation' | 'complete' | 'failed',
  iteration: number,
  max_iterations: number,        // 기본값 10
  originalIdea: string,

  expansion: {
    analyst_complete: boolean,
    architect_complete: boolean,
    spec_path: string | null,    // .omc/autopilot/spec.md
  },

  planning: {
    plan_path: string | null,    // .omc/plans/autopilot-impl.md
    architect_iterations: number,
    approved: boolean,
  },

  execution: {
    ralph_iterations: number,
    ultrawork_active: boolean,
    tasks_completed: number,
    tasks_total: number,
    files_created: string[],
    files_modified: string[],
  },

  qa: {
    ultraqa_cycles: number,
    build_status: 'pending' | 'passing' | 'failing',
    lint_status: 'pending' | 'passing' | 'failing',
    test_status: 'pending' | 'passing' | 'failing' | 'skipped',
  },

  validation: {
    architects_spawned: number,
    verdicts: ValidationResult[],
    all_approved: boolean,
    validation_rounds: number,
  },

  started_at: string,
  completed_at: string | null,
  total_agents_spawned: number,
}
```

---

## 페이즈 전환 특수 처리

Phase 2→3과 3→4는 단순 전환이 아니라 **모드 스위칭**이 필요하다:

- **Execution → QA:** Ralph + Ultrawork 상태를 정리하고 UltraQA 시작 (rollback 지원)
- **QA → Validation:** UltraQA 상태를 정리하고 Validation 시작

---

## 기본 설정값 (AutopilotConfig)

```typescript
{
  maxIterations: 10,              // 전체 반복 안전 한계
  maxExpansionIterations: 2,      // Expansion 최대 반복
  maxArchitectIterations: 5,      // Planning 내 Architect 반복
  maxQaCycles: 5,                 // QA 사이클 한계
  maxValidationRounds: 3,         // Validation 라운드 한계
  parallelExecutors: 5,           // 병렬 Executor 수
  pauseAfterExpansion: false,     // Expansion 후 사용자 확인
  pauseAfterPlanning: false,      // Planning 후 사용자 확인
  skipQa: false,                  // QA 단계 건너뛰기
  skipValidation: false,          // Validation 단계 건너뛰기
  autoCommit: false,              // 자동 커밋
  validationArchitects: ['functional', 'security', 'quality']
}
```

---

## 위임 규칙

Autopilot 오케스트레이터는 **직접 소스 코드를 편집하지 않는다**. 모든 구현은 Executor 에이전트에 위임하며, 오케스트레이터가 직접 편집 가능한 파일은 다음뿐이다:

- `.omc/`
- `.claude/`
- `CLAUDE.md`
- `AGENTS.md`

---

## 취소 및 재개

| 동작 | 설명 |
|------|------|
| `cancelAutopilot()` | 비활성화하되 상태 보존 (재개 가능) |
| `clearAutopilot()` | 상태 완전 삭제 (재개 불가) |
| `canResumeAutopilot()` | 재개 가능 여부 확인 |
| `resumeAutopilot()` | 재활성화 후 중단 지점부터 계속 |

---

## 관련 소스 파일

| 파일 | 역할 |
|------|------|
| `skills/autopilot/SKILL.md` | 스킬 정의 (전체 워크플로우) |
| `commands/autopilot.md` | 명령 템플릿 |
| `src/hooks/autopilot/types.ts` | 타입 정의 (상태, 시그널, 설정) |
| `src/hooks/autopilot/state.ts` | 상태 읽기/쓰기/전환 |
| `src/hooks/autopilot/prompts.ts` | 페이즈별 프롬프트 생성 |
| `src/hooks/autopilot/enforcement.ts` | 시그널 감지 + 페이즈 진행 |
| `src/hooks/autopilot/validation.ts` | 검증 판정 관리 |
| `src/hooks/autopilot/cancel.ts` | 취소/재개 |
| `src/hooks/persistent-mode/index.ts` | Self-loop 실행 엔진 |

---

## persistent-mode 훅 우선순위

```
Priority 0:   Ralph (최고 - 검증 포함 가능)
Priority 1.5: Autopilot (전체 오케스트레이션)
Priority 2:   Ultrawork (성능 모드)
```

---

## 다른 기능과의 통합

- **Magic Keywords:** keyword-detector 훅이 자동 감지 → `initAutopilot()` 트리거
- **Model Routing:** 에이전트별 티어 모델 자동 배정 (Opus/Sonnet/Haiku)
- **Ralph:** Phase 2에서 Ralph + Ultrawork 사용, 상태 전환 시 정리
- **UltraQA:** Phase 3에서 UltraQA 모드 사용, 별도 상태 관리
- **상호 배제:** `canStartMode()`로 다른 persistent 모드와 동시 실행 방지
