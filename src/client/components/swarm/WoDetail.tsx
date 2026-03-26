import { useMemo, useState, type ReactNode } from 'react'
import { useSwarmStore } from '../../stores/swarmStore'
import type { ErrorHistoryEntry, GateResultSummary, SwarmWoState, WoStatus } from '@shared/swarmTypes'

export interface WoDetailProps {
  wo: SwarmWoState | null
}

const STATUS_STYLES: Record<WoStatus, string> = {
  pending: 'bg-gray-600/30 text-gray-200 border border-gray-500/40',
  ready: 'bg-[#1e3a5f]/80 text-blue-200 border border-blue-500/30',
  running: 'bg-blue-500/20 text-blue-300 border border-blue-500/40',
  completed: 'bg-green-500/20 text-green-300 border border-green-500/40',
  failed: 'bg-red-500/20 text-red-300 border border-red-500/40',
  escalated: 'bg-amber-500/20 text-amber-300 border border-amber-500/40',
}

function formatTokens(value: number | null | undefined): string {
  if (!Number.isFinite(value)) {
    return '0'
  }

  if ((value ?? 0) >= 1000) {
    return `${((value ?? 0) / 1000).toFixed(1)}K`
  }

  return String(value ?? 0)
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) {
    return null
  }

  const totalSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor(totalSeconds / 60)
  const remainingSeconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${remainingSeconds}s`
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`
  }

  return `${remainingSeconds}s`
}

function truncateText(value: string, maxLength = 140): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength - 1)}…`
}

function buildTierLabel(wo: SwarmWoState): string {
  const isEscalated = wo.errorHistory.some((entry) => entry.tier < wo.escalationTier)
  return `${wo.model || 'unknown'} (tier ${wo.escalationTier}${isEscalated ? ', escalated' : ''})`
}

function formatAttemptCounter(attempt: number, maxRetries: number): string {
  const totalAttempts = Math.max(attempt, maxRetries + 1)
  return `Attempt ${attempt}/${totalAttempts}`
}

function Section({
  title,
  open,
  onToggle,
  children,
  count,
}: {
  title: string
  open: boolean
  onToggle: () => void
  children: ReactNode
  count?: number
}) {
  return (
    <section className="rounded-md border border-white/8 bg-black/10">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-gray-200 transition-colors hover:bg-white/5"
      >
        <span>
          {open ? '▼' : '▶'} {title}
          {typeof count === 'number' ? <span className="ml-2 text-gray-500">({count})</span> : null}
        </span>
      </button>
      {open && <div className="border-t border-white/8 px-3 py-3">{children}</div>}
    </section>
  )
}

function GateList({ gateResults }: { gateResults: GateResultSummary }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  return (
    <div className="space-y-2">
      {gateResults.gates.map((gate) => {
        const isOpen = expanded[gate.name] ?? false

        return (
          <div key={gate.name} className="rounded-md border border-white/8 bg-white/5">
            <div className="flex items-start justify-between gap-3 px-3 py-2 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                <span className={gate.passed ? 'text-green-400' : 'text-red-400'}>{gate.passed ? '✓' : '✕'}</span>
                <span className="truncate text-gray-100">{gate.name}</span>
              </div>
              {gate.output ? (
                <button
                  type="button"
                  onClick={() => setExpanded((current) => ({ ...current, [gate.name]: !isOpen }))}
                  className="shrink-0 text-[11px] text-blue-300 transition-colors hover:text-blue-200"
                >
                  {isOpen ? 'Hide output' : 'Show output'}
                </button>
              ) : null}
            </div>
            {isOpen && gate.output ? (
              <pre className="overflow-x-auto border-t border-white/8 px-3 py-2 text-[11px] text-gray-300 whitespace-pre-wrap">
                {gate.output}
              </pre>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function ErrorHistoryList({ entries }: { entries: ErrorHistoryEntry[] }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})

  return (
    <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
      {entries
        .slice()
        .reverse()
        .map((entry, index) => {
          const isOpen = expanded[index] ?? false

          return (
            <div key={`${entry.tier}-${entry.model}-${entry.attempt}-${index}`} className="rounded-md border border-red-500/20 bg-red-500/5 p-3">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded-full border border-red-500/30 bg-red-500/15 px-2 py-0.5 text-red-300">
                  tier {entry.tier}
                </span>
                <span className="text-gray-200">{entry.model}</span>
                <span className="text-gray-500">attempt {entry.attempt}</span>
              </div>
              <p className="mt-2 text-xs text-gray-300" title={entry.error}>
                {isOpen ? entry.error : truncateText(entry.error)}
              </p>
              {entry.gateDetail ? (
                <p className="mt-2 text-[11px] text-gray-500" title={entry.gateDetail}>
                  {isOpen ? entry.gateDetail : truncateText(entry.gateDetail, 120)}
                </p>
              ) : null}
              {(entry.error.length > 140 || (entry.gateDetail?.length ?? 0) > 120) ? (
                <button
                  type="button"
                  onClick={() => setExpanded((current) => ({ ...current, [index]: !isOpen }))}
                  className="mt-2 text-[11px] text-blue-300 transition-colors hover:text-blue-200"
                >
                  {isOpen ? 'Collapse' : 'Expand'}
                </button>
              ) : null}
            </div>
          )
        })}
    </div>
  )
}


function classifyDiffLine(line: string): 'add' | 'remove' | 'hunk' | 'header' | 'context' {
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
    return 'header'
  }
  if (line.startsWith('@@')) {
    return 'hunk'
  }
  if (line.startsWith('+')) {
    return 'add'
  }
  if (line.startsWith('-')) {
    return 'remove'
  }
  return 'context'
}

const DIFF_LINE_STYLES: Record<'add' | 'remove' | 'hunk' | 'header' | 'context', string> = {
  add: 'bg-green-500/15 text-green-300',
  remove: 'bg-red-500/15 text-red-300',
  hunk: 'text-purple-400',
  header: 'text-gray-400 font-semibold',
  context: 'text-gray-400',
}

function UnifiedDiffViewer({ diff }: { diff: string }) {
  const [showAll, setShowAll] = useState(false)

  const lines = useMemo(() => diff.split('\n'), [diff])
  const displayLines = showAll ? lines : lines.slice(0, 30)
  const hasMore = lines.length > 30

  return (
    <div>
      <pre className="max-h-[500px] overflow-auto rounded-md border border-white/8 bg-black/20 p-3 text-xs font-mono">
        {displayLines.map((line, index) => {
          const category = classifyDiffLine(line)
          const style = DIFF_LINE_STYLES[category]
          const content = line === '' ? '\u00A0' : line

          return (
            <div key={index} className={style}>
              {content}
            </div>
          )
        })}
      </pre>
      {hasMore && !showAll ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 text-[11px] text-blue-300 transition-colors hover:text-blue-200"
        >
          Show all {lines.length} lines
        </button>
      ) : null}
    </div>
  )
}

export default function WoDetail({ wo }: WoDetailProps) {
  const [showDependencies, setShowDependencies] = useState(true)
  const [showGates, setShowGates] = useState(true)
  const [showErrors, setShowErrors] = useState(true)
  const [showFiles, setShowFiles] = useState(true)
  const [showDiff, setShowDiff] = useState(false)

  const groups = useSwarmStore((state) => state.groups)

  const dependencyStates = useMemo(() => {
    if (!wo) {
      return []
    }

    const parentGroup = groups.find((group) => group.wos[wo.woId])

    return wo.dependsOn.map((dependencyId) => ({
      woId: dependencyId,
      status: parentGroup?.wos[dependencyId]?.status ?? 'pending',
    }))
  }, [groups, wo])

  if (!wo) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center rounded-lg border border-dashed border-white/10 bg-[#1a1a2e] px-4 text-sm text-gray-500">
        Select a work order
      </div>
    )
  }

  const durationText =
    wo.durationSeconds !== null
      ? formatDuration(wo.durationSeconds)
      : wo.startedAt && wo.completedAt
        ? formatDuration((new Date(wo.completedAt).getTime() - new Date(wo.startedAt).getTime()) / 1000)
        : null

  return (
    <div className="h-full space-y-3 rounded-lg border border-white/10 bg-[#1a1a2e] p-4 text-sm shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] text-gray-500">Work Order</div>
          <div className="mt-1 flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-white">{wo.woId}</h3>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[wo.status]}`}>
              {wo.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-300">{wo.title}</p>
        </div>
        <div className="text-right text-[11px] text-gray-400">
          <div>{buildTierLabel(wo)}</div>
          <div className="mt-1">{formatAttemptCounter(wo.attempt, wo.maxRetries)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 text-xs text-gray-300 xl:grid-cols-2">
        <div className="rounded-md border border-white/8 bg-black/10 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.16em] text-gray-500">Escalation Chain</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {wo.escalationChain.length > 0 ? (
              wo.escalationChain.map((tier, index) => {
                const isCurrent = index === wo.escalationTier
                const isPast = index < wo.escalationTier
                const pillClass = isCurrent
                  ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
                  : isPast
                    ? 'border-red-500/30 bg-red-500/10 text-red-300'
                    : 'border-gray-600/50 bg-gray-700/30 text-gray-400'

                return (
                  <div key={`${tier.model}-${index}`} className="flex items-center gap-2">
                    <span className={`rounded-full border px-2 py-1 text-[11px] ${pillClass}`}>
                      {tier.model}
                    </span>
                    {index < wo.escalationChain.length - 1 ? <span className="text-gray-600">→</span> : null}
                  </div>
                )
              })
            ) : (
              <span className="rounded-full border border-blue-500/40 bg-blue-500/15 px-2 py-1 text-[11px] text-blue-300">
                {wo.model || `tier ${wo.escalationTier}`}
              </span>
            )}
          </div>
        </div>
        <div className="rounded-md border border-white/8 bg-black/10 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.16em] text-gray-500">Usage</div>
          <div className="mt-2 space-y-1 text-xs">
            <div>{formatTokens(wo.tokenUsage.inputTokens)} input / {formatTokens(wo.tokenUsage.outputTokens)} output tokens</div>
            {durationText ? <div className="text-gray-400">Duration {durationText}</div> : null}
          </div>
        </div>
      </div>

      <Section title="Dependencies" count={dependencyStates.length} open={showDependencies} onToggle={() => setShowDependencies((open) => !open)}>
        {dependencyStates.length > 0 ? (
          <div className="space-y-2">
            {dependencyStates.map((dependency) => (
              <div key={dependency.woId} className="flex items-center justify-between gap-3 rounded-md bg-white/5 px-3 py-2 text-xs">
                <span className="font-mono text-gray-200">{dependency.woId}</span>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[dependency.status]}`}>
                  {dependency.status}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-gray-500">No dependencies</div>
        )}
      </Section>

      {wo.gateResults ? (
        <Section
          title={`Gate Results${wo.gateResults.allPassed ? '' : ' (attention)'}`}
          count={wo.gateResults.gates.length}
          open={showGates}
          onToggle={() => setShowGates((open) => !open)}
        >
          <GateList gateResults={wo.gateResults} />
        </Section>
      ) : null}

      {wo.errorHistory.length > 0 ? (
        <Section title="Error History" count={wo.errorHistory.length} open={showErrors} onToggle={() => setShowErrors((open) => !open)}>
          <ErrorHistoryList entries={wo.errorHistory} />
        </Section>
      ) : null}

      {wo.filesChanged.length > 0 ? (
        <Section title="Files Changed" count={wo.filesChanged.length} open={showFiles} onToggle={() => setShowFiles((open) => !open)}>
          <div className="max-h-40 space-y-1 overflow-y-auto pr-1 text-xs">
            {wo.filesChanged.map((path) => (
              <div key={path} className="rounded bg-white/5 px-2 py-1 font-mono text-gray-300">
                {path}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {wo.unifiedDiff ? (
        <Section title="Diff" open={showDiff} onToggle={() => setShowDiff((open) => !open)}>
          <UnifiedDiffViewer diff={wo.unifiedDiff} />
        </Section>
      ) : null}
    </div>
  )
}
