# Spec Planning — Orchestrator Template

## Variables

- `{{ spec_path }}` — Path to the feature specification
- `{{ constitution_sections }}` — Constitution sections to check against
- `{{ output_dir }}` — Output directory for refined spec
- `{{ signals_dir }}` — Signal directory for protocol communication
- `{{ language }}` — Primary project language
- `{{ framework }}` — Primary project framework

## Structured Self-Interrogation (R6)

Before producing the refined spec, systematically address each category:

### 1. Completeness
- Does the spec define all required fields (title, acceptance, scope)?
- Are there implicit assumptions that should be made explicit?
- What edge cases are not addressed?

### 2. Consistency
- Do acceptance criteria align with the stated scope?
- Are there contradictions between constraints and requirements?
- Does the priority match the scope of change?

### 3. Testability
- Can each acceptance criterion be verified automatically?
- Are benchmarks quantified with specific thresholds?
- Are contract criteria expressed as type-checkable interfaces?

### 4. Security
- Does the scope include files that handle authentication or authorization?
- Are there credential or secret patterns in the spec?
- Does the change affect any security-critical paths?

### 5. Architecture
- Is the scope bounded to a single service/module, or does it cross boundaries?
- Are there wildcard scope patterns that are overly broad?
- Does the change align with existing architectural patterns?

### 6. Dependencies
- What existing code will be affected by this change?
- Are there circular dependency risks?
- What external libraries or services are involved?

### 7. Risk Assessment
- What is the blast radius if the implementation is incorrect?
- Are there rollback strategies?
- What monitoring or observability changes are needed?

## Output

Produce a refined spec at `{{ output_dir }}/refined-spec.yaml` that addresses
all findings from the self-interrogation. Mark any unresolvable concerns as
open questions with `status: needs_clarification`.
