# Decomposition — Orchestrator Template

## Variables

- `{{ spec_path }}` — Path to the approved feature specification
- `{{ project_path }}` — Root path of the target project
- `{{ output_dir }}` — Output directory for decomposition artifacts
- `{{ constitution_sections }}` — Constitution sections for validation

## Process

### Step 1: Analyze Spec Scope

Read the approved spec and extract:
- All files mentioned in scope (included and excluded)
- All acceptance criteria grouped by type
- All stated constraints and dependencies

### Step 2: Map Existing Code

For each file in scope:
1. Use `find_symbol` to locate existing implementations
2. Use `file_dependencies` to map import chains
3. Use `call_graph` to understand caller/callee relationships

### Step 3: Identify Work Units

Break the implementation into atomic work units following these rules:
- Each WU touches ≤5 files
- WU dependencies form a DAG (no cycles)
- Each WU has typed acceptance criteria
- Cross-WU interfaces are explicitly declared

### Step 4: Validate Dependency Graph

**Cycle Detection**: After defining all WUs, verify the dependency graph is acyclic.
If cycles are detected:
1. Identify the minimal cycle
2. Extract shared interface into a new WU
3. Make both original WUs depend on the interface WU

### Step 5: Scope Bounding

For each WU, verify:
- Declared files are reachable from the entry points
- No undeclared files would need modification
- The change doesn't leak beyond module boundaries

## Output

Write to `{{ output_dir }}/decomposition/`:
- `manifest.yaml` — Summary with WU list and dependency graph
- `WU-001.yaml`, `WU-002.yaml`, etc. — Individual work unit definitions

## Constraints

- Maximum 20 work units per feature
- No WU should have more than 3 direct dependencies
- Total estimated files across all WUs should not exceed 50
