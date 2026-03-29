import type { TaskTemplate } from '@shared/types'

interface TemplateManagerProps {
  onClose: () => void
}

export default function TemplateManager({ onClose }: TemplateManagerProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-xs font-medium text-white/70">Template Manager</span>
        <button
          onClick={onClose}
          className="text-[10px] px-2 py-1 rounded bg-white/5 text-white/50 hover:bg-white/10 transition-colors"
        >
          Close
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex items-center justify-center h-32 text-xs text-white/30">
          Template management coming soon...
        </div>
      </div>
    </div>
  )
}
