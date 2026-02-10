---
id: task-template-system
source_files:
- src/shared/types.ts
- src/server/taskStore.ts
- src/server/handlers/taskHandlers.ts
- src/server/httpRoutes.ts
- src/client/components/TaskForm.tsx
trust: derived
type: area
---

# Task Template System

## Overview
The task template system provides reusable task definitions with variable substitution. Templates are stored in SQLite and managed via HTTP API and WebSocket handlers.

## Architecture

### Data Model (types.ts:161-172)
```typescript
interface TaskTemplate {
  id: string
  name: string
  promptTemplate: string        // Template with {{variable}} placeholders
  variables: string              // JSON array of variable definitions
  projectPath: string | null     // Optional project binding
  priority: number               // Default priority (1-10)
  timeoutSeconds: number         // Default timeout
  isDefault: boolean             // Whether this is a default template
  createdAt: string
  updatedAt: string
}
```

### Storage (taskStore.ts:100-112)
- **Table**: `task_templates`
- **Indexes**: None (small table, sorted by name in queries)
- **Schema**:
  - `id TEXT PRIMARY KEY`
  - `name TEXT NOT NULL`
  - `prompt_template TEXT NOT NULL`
  - `variables TEXT NOT NULL DEFAULT '[]'` (JSON array)
  - `project_path TEXT` (nullable)
  - `priority INTEGER NOT NULL DEFAULT 5`
  - `timeout_seconds INTEGER NOT NULL DEFAULT 1800`
  - `is_default INTEGER NOT NULL DEFAULT 0`
  - `created_at TEXT NOT NULL DEFAULT (datetime('now'))`
  - `updated_at TEXT NOT NULL DEFAULT (datetime('now'))`

### Variable System

**Variable Definition Format**:
```typescript
interface TemplateVariable {
  name: string
  description?: string
  defaultValue?: string
}
```

**Variable Substitution** (taskHandlers.ts:80-94):
- Pattern: `{{variableName}}` → value
- Uses regex: `\\{\\{${escapedKey}\\}\\}` with global flag
- Validates:
  - Variable keys max 256 chars
  - Variable values max MAX_FIELD_LENGTH (4096)
  - Final prompt max 100,000 chars
- Prevents prompt explosion during substitution

**Example**:
```typescript
// Template
promptTemplate: "Fix the bug in {{file}} on line {{line}}"
variables: '[{"name":"file","description":"File path"},{"name":"line","defaultValue":"1"}]'

// Usage
variables: { file: "src/main.ts", line: "42" }

// Result
"Fix the bug in src/main.ts on line 42"
```

## API Endpoints (httpRoutes.ts:459-537)

### GET /api/templates
- Returns all templates sorted by name
- No pagination (small dataset)

### POST /api/templates
- Creates new template
- Validates:
  - `name` and `promptTemplate` required
  - `variables` must be valid JSON array
- Broadcasts `template-list` to all clients

### PUT /api/templates/:id
- Updates existing template
- Sets `updated_at` automatically
- Partial updates supported
- Broadcasts `template-list`

### DELETE /api/templates/:id
- Removes template
- Returns 404 if not found
- Broadcasts `template-list`

## WebSocket Handlers (taskHandlers.ts)

### template-list-request
- Returns current templates via WebSocket
- Used by TaskForm component on mount

## Client Integration (TaskForm.tsx)

### Template Selection
- Dropdown populated from `templates` prop
- On selection:
  - Loads `promptTemplate` into prompt field
  - Parses `variables` JSON
  - Sets default values from template
  - Updates priority, timeout, projectPath

### Variable Input
- Dynamic form fields generated from variable definitions
- Shows variable name + description
- Pre-fills default values
- Validates length (max 4096 per value)
- Trimmed before submission

### Task Creation
- Sends `task-create` message with:
  - `templateId` (optional)
  - `variables` (optional, only non-empty values)
  - Other task fields (priority, timeout, etc.)

## Relationship to Tasks

When a task is created from a template:
1. `templateId` stored in task record
2. Variables substituted into `promptTemplate`
3. Final prompt stored in task (not the template reference)
4. Template can be deleted without affecting existing tasks

## Differences from Workflows

| Feature | Task Templates | Workflows |
|---------|---------------|-----------|
| Purpose | Single task prompts | Multi-step orchestration |
| Storage | SQLite table | YAML files + SQLite metadata |
| Variables | `{{var}}` substitution | `variables` section in YAML |
| Execution | Creates one task | Creates multiple tasks |
| Conditionals | No | Yes (file_exists, output_contains) |
| Project binding | Optional (projectPath) | Required per step |
| Output capture | No | Yes (result_file, output_path) |

## Usage Patterns

### Global Templates (projectPath: null)
- Available across all projects
- Generic prompts (e.g., "Code review", "Write tests")

### Project-Specific Templates (projectPath: set)
- Tied to specific project
- Can include project-specific context
- Pre-fills project path in TaskForm

### Default Templates (isDefault: true)
- Can be used as quick-start templates
- Not currently enforced in UI (future feature)

## Testing (taskStore.test.ts:362-448)
- Template CRUD operations
- Variable JSON parsing
- Update timestamp behavior
- Name sorting
- Template-to-task relationship
