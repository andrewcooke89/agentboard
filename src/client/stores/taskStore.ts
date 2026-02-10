// taskStore.ts - Zustand store for task queue state
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Task, TaskTemplate, TaskQueueStats } from '@shared/types'
import { safeStorage } from '../utils/storage'

interface TaskState {
  tasks: Task[]
  templates: TaskTemplate[]
  stats: TaskQueueStats
  selectedTaskId: string | null
  showTaskQueue: boolean
  showTemplateManager: boolean
  hasLoaded: boolean

  setTasks: (tasks: Task[]) => void
  setStats: (stats: TaskQueueStats) => void
  addTask: (task: Task) => void
  updateTask: (task: Task) => void
  removeTask: (taskId: string) => void
  setTemplates: (templates: TaskTemplate[]) => void
  setSelectedTaskId: (id: string | null) => void
  setShowTaskQueue: (show: boolean) => void
  setShowTemplateManager: (show: boolean) => void
  getTaskById: (id: string) => Task | undefined
  getTaskBySessionName: (sessionName: string) => Task | undefined
}

export const useTaskStore = create<TaskState>()(
  persist(
    (set, get) => ({
      tasks: [],
      templates: [],
      stats: { queued: 0, running: 0, completedToday: 0, failedToday: 0 },
      selectedTaskId: null,
      showTaskQueue: false,
      showTemplateManager: false,
      hasLoaded: false,

      setTasks: (tasks) => set({ tasks, hasLoaded: true }),
      setStats: (stats) => set({ stats }),
      addTask: (task) => {
        const { tasks } = get()
        if (!tasks.some((t) => t.id === task.id)) {
          set({ tasks: [task, ...tasks] })
        }
      },
      updateTask: (task) =>
        set((state) => ({
          tasks: state.tasks.map((existing) =>
            existing.id === task.id ? task : existing
          ),
        })),
      removeTask: (taskId) =>
        set((state) => ({
          tasks: state.tasks.filter((t) => t.id !== taskId),
        })),
      setTemplates: (templates) => set({ templates }),
      setSelectedTaskId: (id) => set({ selectedTaskId: id }),
      setShowTaskQueue: (show) => set({ showTaskQueue: show }),
      setShowTemplateManager: (show) => set({ showTemplateManager: show }),
      getTaskById: (id) => get().tasks.find((t) => t.id === id),
      getTaskBySessionName: (sessionName) => get().tasks.find((t) => t.sessionName === sessionName),
    }),
    {
      name: 'agentboard-tasks',
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({
        showTaskQueue: state.showTaskQueue,
        selectedTaskId: state.selectedTaskId,
      }),
    }
  )
)
