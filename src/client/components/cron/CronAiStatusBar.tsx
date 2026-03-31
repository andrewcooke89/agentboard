// WU-009: CronAi Status Bar
// Bottom status bar showing MCP connection status, selected job context,
// and pending proposal count badge.

interface CronAiStatusBarProps {
  mcpConnected: boolean
  selectedJobName: string | null
  pendingCount: number
}

export function CronAiStatusBar({ mcpConnected, selectedJobName, pendingCount }: CronAiStatusBarProps) {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 border-t border-zinc-700 bg-zinc-800/50 text-xs">
      {/* MCP connection status */}
      <div className="flex items-center gap-1.5">
        <div className={`w-1.5 h-1.5 rounded-full ${mcpConnected ? 'bg-green-400' : 'bg-red-400'}`} />
        <span className="text-zinc-400">
          {mcpConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {/* Selected job context */}
      <span className="text-zinc-500">
        {selectedJobName ? `Viewing: ${selectedJobName}` : 'No job selected'}
      </span>

      <div className="flex-1" />

      {/* Pending proposal count */}
      {pendingCount > 0 && (
        <span className="bg-blue-600 text-white px-1.5 py-0.5 rounded-full text-[10px] font-medium">
          {pendingCount} pending
        </span>
      )}
    </div>
  )
}

export default CronAiStatusBar
