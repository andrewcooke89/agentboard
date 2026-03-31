// workflowStore.ts - Zustand store for workflow engine state
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { WorkflowDefinition, WorkflowRun } from '@shared/types'
import { safeStorage } from '../utils/storage'
import { authFetch } from '../utils/api'

// ─── Result type for actions ────────────────────────────────────────────────
interface ActionResult {
  ok: boolean
  error?: string
}

// ─── Store interface ────────────────────────────────────────────────────────
interface WorkflowState {
  // State
  workflows: WorkflowDefinition[]
  workflowRuns: WorkflowRun[]
  selectedWorkflowId: string | null
  selectedRunId: string | null
  loadingWorkflows: boolean
  loadingRuns: boolean
  hasLoaded: boolean
  fetchError: string | null

  // Workflow CRUD actions (REST)
  fetchWorkflows: () => Promise<ActionResult>
  createWorkflow: (yamlContent: string, name: string, description?: string) => Promise<ActionResult>
  updateWorkflow: (id: string, updates: { yaml_content?: string; name?: string; description?: string }) => Promise<ActionResult>
  deleteWorkflow: (id: string) => Promise<ActionResult>
  getWorkflow: (id: string) => Promise<ActionResult>

  // Run management actions (REST)
  fetchRuns: (workflowId: string) => Promise<ActionResult>
  getRun: (runId: string) => Promise<ActionResult>
  triggerRun: (workflowId: string, variables?: Record<string, string>) => Promise<ActionResult>
  resumeRun: (runId: string) => Promise<ActionResult>
  cancelRun: (runId: string) => Promise<ActionResult>

  // WebSocket handlers
  handleWorkflowList: (workflows: WorkflowDefinition[]) => void
  handleWorkflowUpdated: (workflow: WorkflowDefinition) => void
  handleWorkflowRemoved: (workflowId: string) => void
  handleWorkflowRunUpdate: (run: WorkflowRun) => void
  handleWorkflowRunList: (runs: WorkflowRun[]) => void

  // Selection
  selectWorkflow: (id: string | null) => void
  selectRun: (id: string | null) => void
}

// ─── Store implementation ───────────────────────────────────────────────────
export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set) => ({
      // Initial state
      workflows: [],
      workflowRuns: [],
      selectedWorkflowId: null,
      selectedRunId: null,
      loadingWorkflows: false,
      loadingRuns: false,
      hasLoaded: false,
      fetchError: null,

      // ── Workflow CRUD ───────────────────────────────────────────────────

      fetchWorkflows: async () => {
        set({ loadingWorkflows: true })
        try {
          const res = await authFetch('/api/workflows')
          if (!res.ok) {
            const text = await res.text()
            set({ loadingWorkflows: false, fetchError: text || `HTTP ${res.status}` })
            return { ok: false, error: text || `HTTP ${res.status}` }
          }
          const data = await res.json()
          const workflows: WorkflowDefinition[] = data.workflows
          set({ workflows, loadingWorkflows: false, hasLoaded: true, fetchError: null })
          return { ok: true }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Network error'
          set({ loadingWorkflows: false, fetchError: msg })
          return { ok: false, error: msg }
        }
      },

      createWorkflow: async (yamlContent, name, description) => {
        try {
          const res = await authFetch('/api/workflows', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ yaml_content: yamlContent, name, description }),
          })
          if (!res.ok) {
            const text = await res.text()
            return { ok: false, error: text || `HTTP ${res.status}` }
          }
          const workflow: WorkflowDefinition = await res.json()
          set((state) => ({ workflows: [workflow, ...state.workflows] }))
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
        }
      },

      updateWorkflow: async (id, updates) => {
        try {
          const res = await authFetch(`/api/workflows/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
          })
          if (!res.ok) {
            const text = await res.text()
            return { ok: false, error: text || `HTTP ${res.status}` }
          }
          const workflow: WorkflowDefinition = await res.json()
          set((state) => ({
            workflows: state.workflows.map((w) => (w.id === id ? workflow : w)),
          }))
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
        }
      },

      deleteWorkflow: async (id) => {
        try {
          const res = await authFetch(`/api/workflows/${id}`, {
            method: 'DELETE',
          })
          if (!res.ok) {
            const text = await res.text()
            return { ok: false, error: text || `HTTP ${res.status}` }
          }
          set((state) => ({
            workflows: state.workflows.filter((w) => w.id !== id),
            selectedWorkflowId: state.selectedWorkflowId === id ? null : state.selectedWorkflowId,
          }))
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
        }
      },

      getWorkflow: async (id) => {
        try {
          const res = await authFetch(`/api/workflows/${id}`)
          if (!res.ok) {
            if (res.status === 404) {
              set({ selectedWorkflowId: null })
            }
            const text = await res.text()
            return { ok: false, error: text || `HTTP ${res.status}` }
          }
          const workflow: WorkflowDefinition = await res.json()
          set((state) => ({
            workflows: state.workflows.some((w) => w.id === id)
              ? state.workflows.map((w) => (w.id === id ? workflow : w))
              : [...state.workflows, workflow],
            selectedWorkflowId: id,
          }))
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
        }
      },

      // ── Run management ─────────────────────────────────────────────────

      fetchRuns: async (workflowId) => {
        set({ loadingRuns: true })
        try {
          const res = await authFetch(`/api/workflows/${workflowId}/runs`)
          if (!res.ok) {
            const text = await res.text()
            set({ loadingRuns: false })
            return { ok: false, error: text || `HTTP ${res.status}` }
          }
          const data = await res.json()
          const runs: WorkflowRun[] = data.runs
          set({ workflowRuns: runs, loadingRuns: false })
          return { ok: true }
        } catch (err) {
          set({ loadingRuns: false })
          return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
        }
      },

      getRun: async (runId) => {
        try {
          const res = await authFetch(`/api/workflow-runs/${runId}`)
          if (!res.ok) {
            if (res.status === 404) {
              set({ selectedRunId: null })
            }
            const text = await res.text()
            return { ok: false, error: text || `HTTP ${res.status}` }
          }
          const run: WorkflowRun = await res.json()
          set((state) => ({
            workflowRuns: state.workflowRuns.some((r) => r.id === runId)
              ? state.workflowRuns.map((r) => (r.id === runId ? run : r))
              : [...state.workflowRuns, run],
            selectedRunId: runId,
          }))
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
        }
      },

      triggerRun: async (workflowId, variables) => {
        try {
          const res = await authFetch(`/api/workflows/${workflowId}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(variables ? { variables } : {}),
          })
          if (!res.ok) {
            const text = await res.text()
            return { ok: false, error: text || `HTTP ${res.status}` }
          }
          const run: WorkflowRun = await res.json()
          set((state) => ({
            workflowRuns: [run, ...state.workflowRuns],
          }))
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
        }
      },

      resumeRun: async (runId) => {
        try {
          const res = await authFetch(`/api/workflow-runs/${runId}/resume`, {
            method: 'POST',
          })
          if (!res.ok) {
            if (res.status === 404) {
              set({ selectedRunId: null })
            }
            const text = await res.text()
            return { ok: false, error: text || `HTTP ${res.status}` }
          }
          const run: WorkflowRun = await res.json()
          set((state) => ({
            workflowRuns: state.workflowRuns.map((r) => (r.id === runId ? run : r)),
            selectedRunId: runId,
          }))
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
        }
      },

      cancelRun: async (runId) => {
        try {
          const res = await authFetch(`/api/workflow-runs/${runId}/cancel`, {
            method: 'POST',
          })
          if (!res.ok) {
            if (res.status === 404) {
              set({ selectedRunId: null })
            }
            const text = await res.text()
            return { ok: false, error: text || `HTTP ${res.status}` }
          }
          const run: WorkflowRun = await res.json()
          set((state) => ({
            workflowRuns: state.workflowRuns.map((r) => (r.id === runId ? run : r)),
            selectedRunId: runId,
          }))
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
        }
      },

      // ── WebSocket handlers ─────────────────────────────────────────────

      handleWorkflowList: (workflows) => {
        set({ workflows, hasLoaded: true })
      },

      handleWorkflowUpdated: (workflow) => {
        set((state) => {
          const exists = state.workflows.some((w) => w.id === workflow.id)
          return {
            workflows: exists
              ? state.workflows.map((w) => (w.id === workflow.id ? workflow : w))
              : [...state.workflows, workflow],
          }
        })
      },

      handleWorkflowRemoved: (workflowId) => {
        set((state) => ({
          workflows: state.workflows.filter((w) => w.id !== workflowId),
          selectedWorkflowId:
            state.selectedWorkflowId === workflowId ? null : state.selectedWorkflowId,
        }))
      },

      handleWorkflowRunUpdate: (run) => {
        set((state) => {
          const exists = state.workflowRuns.some((r) => r.id === run.id)
          return {
            workflowRuns: exists
              ? state.workflowRuns.map((r) => (r.id === run.id ? run : r))
              : [run, ...state.workflowRuns],
          }
        })
      },

      handleWorkflowRunList: (runs) => {
        set({ workflowRuns: runs })
      },

      // ── Selection ──────────────────────────────────────────────────────

      selectWorkflow: (id) => set({ selectedWorkflowId: id }),
      selectRun: (id) => set({ selectedRunId: id }),
    }),
    {
      name: 'agentboard-workflows',
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({
        selectedWorkflowId: state.selectedWorkflowId,
        selectedRunId: state.selectedRunId,
      }),
    }
  )
)

// ─── Computed selectors ───────────────────────────────────────────────────────

/** Returns only runs with status 'running' */
export const getActiveRuns = (): WorkflowRun[] =>
  useWorkflowStore.getState().workflowRuns.filter((r) => r.status === 'running')

/** Returns runs for a specific workflow */
export const getRunsByWorkflow = (workflowId: string): WorkflowRun[] =>
  useWorkflowStore.getState().workflowRuns.filter((r) => r.workflow_id === workflowId)

/** Returns only workflows where is_valid is true */
export const getValidWorkflows = (): WorkflowDefinition[] =>
  useWorkflowStore.getState().workflows.filter((w) => w.is_valid)

// Hook-based selectors for reactive use in components
// Note: useShallow prevents infinite re-renders from .filter() creating new array references.
export const useActiveRuns = (): WorkflowRun[] =>
  useWorkflowStore(useShallow((state) => state.workflowRuns.filter((r) => r.status === 'running')))

export const useRunsByWorkflow = (workflowId: string): WorkflowRun[] =>
  useWorkflowStore(useShallow((state) => state.workflowRuns.filter((r) => r.workflow_id === workflowId)))

export const useValidWorkflows = (): WorkflowDefinition[] =>
  useWorkflowStore(useShallow((state) => state.workflows.filter((w) => w.is_valid)))
