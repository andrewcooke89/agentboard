import { useTicketStore } from '../../stores/ticketStore'
import type { TicketSummary } from '../../stores/ticketStore'

const severityColor: Record<string, string> = {
  critical: 'text-red-500',
  high: 'text-orange-400',
  medium: 'text-yellow-400',
  low: 'text-blue-400',
  info: 'text-gray-400',
}

const effortBadge: Record<string, string> = {
  small: 'bg-green-900/30 text-green-400 border-green-800/50',
  medium: 'bg-yellow-900/30 text-yellow-400 border-yellow-800/50',
  large: 'bg-red-900/30 text-red-400 border-red-800/50',
}

export default function TicketTable() {
  const tickets = useTicketStore(s => s.tickets)
  const selectedTicketId = useTicketStore(s => s.selectedTicketId)
  const selectTicket = useTicketStore(s => s.selectTicket)
  const dispatchFix = useTicketStore(s => s.dispatchFix)
  const dispatchingTicketId = useTicketStore(s => s.dispatchingTicketId)

  if (tickets.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-[var(--text-secondary)] text-sm">
        No tickets match current filters
      </div>
    )
  }

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--border)]">
          <th className="py-1.5 px-2 font-medium">ID</th>
          <th className="py-1.5 px-2 font-medium">Title</th>
          <th className="py-1.5 px-2 font-medium">Severity</th>
          <th className="py-1.5 px-2 font-medium">Effort</th>
          <th className="py-1.5 px-2 font-medium">Category</th>
          <th className="py-1.5 px-2 font-medium">File</th>
          <th className="py-1.5 px-2 font-medium w-20"></th>
        </tr>
      </thead>
      <tbody>
        {tickets.map(ticket => (
          <TicketRow
            key={ticket.id}
            ticket={ticket}
            selected={ticket.id === selectedTicketId}
            onSelect={() => selectTicket(ticket.id === selectedTicketId ? null : ticket.id)}
            onFix={() => dispatchFix(ticket.id)}
            dispatching={ticket.id === dispatchingTicketId}
          />
        ))}
      </tbody>
    </table>
  )
}

function TicketRow({ ticket, selected, onSelect, onFix, dispatching }: {
  ticket: TicketSummary
  selected: boolean
  onSelect: () => void
  onFix: () => void
  dispatching: boolean
}) {
  const fileName = ticket.source.file.split('/').pop() ?? ticket.source.file
  const isBlocked = ticket.is_blocked
  const isFixable = ticket.status === 'open' && !isBlocked

  return (
    <tr
      onClick={onSelect}
      className={`border-b border-[var(--border)] cursor-pointer transition-colors ${
        selected ? 'bg-accent/10' : 'hover:bg-[var(--bg-hover)]'
      } ${isBlocked ? 'opacity-60' : ''}`}
    >
      <td className="py-1.5 px-2 font-mono">
        {ticket.id}
        {isBlocked && <span className="ml-1 text-red-400" title="Blocked">●</span>}
      </td>
      <td className="py-1.5 px-2 max-w-[300px] truncate">{ticket.title}</td>
      <td className={`py-1.5 px-2 ${severityColor[ticket.severity] ?? ''}`}>{ticket.severity}</td>
      <td className="py-1.5 px-2">
        <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] ${effortBadge[ticket.effort] ?? 'border-gray-700 text-gray-400'}`}>
          {ticket.effort}
        </span>
      </td>
      <td className="py-1.5 px-2 text-[var(--text-secondary)]">{ticket.category}</td>
      <td className="py-1.5 px-2 text-[var(--text-secondary)] font-mono max-w-[150px] truncate" title={ticket.source.file}>
        {fileName}:{ticket.source.line_start}
      </td>
      <td className="py-1.5 px-2">
        {isFixable && (
          <button
            onClick={e => { e.stopPropagation(); onFix() }}
            disabled={dispatching}
            className="rounded border border-accent/50 bg-accent/10 px-2 py-0.5 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {dispatching ? '...' : 'Fix'}
          </button>
        )}
      </td>
    </tr>
  )
}
