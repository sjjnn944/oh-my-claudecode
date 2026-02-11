# `/plan --consensus` (= `/ralplan`) 상세 설명

## Context

사용자가 `/plan --consensus` 워크플로우의 동작 방식을 이해하고자 함. 이것은 구현 계획이 아닌 기능 설명 문서.

---

## 개요

`/plan --consensus`는 **3개의 Opus 에이전트가 합의에 도달할 때까지 반복 검토하는 고품질 계획 수립 워크플로우**이다.

- **별칭:** `/ralplan`, `rp`, `planloop`
- **일반 `/plan`과의 차이:** 필수적으로 Architect + Critic의 다중 관점 검토가 포함됨

---

## 워크플로우 흐름

```
사용자 입력 (간략한 요구사항)
    │
    ▼
┌─────────────────────────────────┐
│  1. PLANNER (Opus)              │
│  - 사용자 인터뷰 (한 번에 1질문) │
│  - explore 에이전트로 코드베이스 조사 │
│  - analyst(Metis) 상담 → 숨은 요구사항 발굴 │
│  - 초기 계획 생성               │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│  2. ARCHITECT (Opus, READ-ONLY) │
│  - 아키텍처 건전성 검토          │
│  - 기술적 실현 가능성 확인        │
│  - 모든 발견에 file:line 근거 제시 │
│  - 피드백 제공                   │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│  3. CRITIC (Opus, READ-ONLY)    │
│  - 4가지 기준으로 평가:          │
│    · Clarity (명확성) 80%+       │
│    · Verification (검증가능성)    │
│    · Completeness (완전성) 90%+  │
│    · Big Picture (전체 맥락)     │
│  - 판정: OKAY 또는 REJECT        │
└──────────┬──────────────────────┘
           │
     ┌─────┴─────┐
     │           │
  REJECT       OKAY
     │           │
     ▼           ▼
  Planner에    사용자에게
  피드백 전달   최종 승인 요청
  (1번으로     ┌──────────┐
   돌아감)     │ Approve  │→ 실행 시작
  최대 5회     │ Adjust   │→ 재계획
  반복         │ Reject   │→ 폐기
               └──────────┘
```

---

## 4개 에이전트 역할 비교

| 에이전트 | 모델 | 권한 | 핵심 역할 | 하지 않는 것 |
|---------|------|------|----------|------------|
| **Planner** | Opus | Read+Write | 인터뷰, 요구사항 수집, 계획 생성 | 코드 작성, 구현 |
| **Analyst** | Opus | Read-only | 숨은 요구사항, 엣지케이스, 리스크 발굴 | 코드 분석, 계획 생성 |
| **Architect** | Opus | Read-only | 아키텍처 검토, 기술적 실현가능성 | 계획 생성, 구현 |
| **Critic** | Opus | Read-only | 계획 품질 평가, OKAY/REJECT 판정 | 요구사항 분석, 구현 |

---

## 일반 `/plan`과의 차이

| 측면 | `/plan` (기본) | `/plan --consensus` |
|------|---------------|---------------------|
| 검토 주체 | 선택적 (Critic만) | 필수 (Architect + Critic) |
| 반복 횟수 | 0~1회 | 최대 5회 |
| 관점 수 | 단일 | 3개 (Planner + Architect + Critic) |
| 사용자 승인 | 있음 | 있음 (합의 후) |
| 적합한 상황 | 간단한 기능, 명확한 요구사항 | 복잡한 아키텍처, 높은 품질 보장 필요 |

---

## `/plan`의 4가지 모드 전체 비교

| 모드 | 트리거 | 동작 |
|------|--------|------|
| **Interview** | 기본 (모호한 요청) | 대화형 요구사항 수집 → 계획 |
| **Direct** | `--direct` (상세한 요청) | 인터뷰 생략, 바로 계획 생성 |
| **Consensus** | `--consensus` / `/ralplan` | Planner→Architect→Critic 반복 루프 |
| **Review** | `--review` / `/review` | 기존 계획에 대한 Critic 평가만 |

---

## 산출물

- **저장 위치:** `.omc/plans/{name}.md`
- **초안:** `.omc/drafts/`
- **상태 파일:** `.omc/state/ralplan-state.json`

**계획 포맷:**
- Requirements Summary (요구사항 요약)
- Acceptance Criteria (수용 기준 - 테스트 가능해야 함)
- Implementation Steps (구현 단계 - file:line 참조 포함)
- Risks and Mitigations (리스크와 대응책)
- Verification Steps (검증 단계)

---

## 관련 파일

- `skills/plan/SKILL.md` — 마스터 스킬 정의
- `commands/ralplan.md` — 별칭 명령 정의
- `agents/planner.md` — Planner 프롬프트
- `agents/architect.md` — Architect 프롬프트
- `agents/critic.md` — Critic 프롬프트
- `agents/analyst.md` — Analyst 프롬프트
- `src/agents/definitions.ts` — 에이전트 등록
