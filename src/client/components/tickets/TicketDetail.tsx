import { useTicketStore } from '../../stores/ticketStore'

export default function TicketDetail() {
  const ticket = useTicketStore(s => s.selectedTicket)
  const selectedId = useTicketStore(s => s.selectedTicketId)
  const dispatchFix = useTicketStore(s => s.dispatchFix)
  const transitionTicket = useTicketStore(s => s.transitionTicket)
  const dispatchingTicketId = useTicketStore(s => s.dispatchingTicketId)
  const selectTicket = useTicketStore(s => s.selectTicket)

  if (!selectedId) return null

  if (!ticket) {
    return (
      <div className="rounded border border-[var(--border)] bg-[var(--bg-base)] p-3 text-sm text-[var(--text-secondary)]">
        Loading {selectedId}...
      </div>
    )
  }

  const isFixable = ticket.status === 'open'
  const isBlocked = ticket.notes?.some(n => n.content.includes('Auto-blocked'))

  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg-base)] p-3 text-xs space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <div className="font-mono text-[var(--text-secondary)]">{ticket.id}</div>
          <div className="font-medium text-sm mt-0.5">{ticket.title}</div>
        </div>
        <button onClick={() => selectTicket(null)} aria-label="Close detail panel" className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
      </div>

      <div className="grid grid-cols-2 gap-1 text-[var(--text-secondary)]">
        <div>Status: <span className="text-[var(--text-primary)]">{ticket.status}</span></div>
        <div>Severity: <span className="text-[var(--text-primary)]">{ticket.severity}</span></div>
        <div>Effort: <span className="text-[var(--text-primary)]">{ticket.effort}</span></div>
        <div>Category: <span className="text-[var(--text-primary)]">{ticket.category}</span></div>
      </div>

      <div>
        <div className="font-medium text-[var(--text-secondary)] mb-1">File</div>
        <div className="font-mono text-[var(--text-primary)]">
          {ticket.source.file.split('/').slice(-2).join('/')}:{ticket.source.line_start}
          {ticket.source.line_end ? `-${ticket.source.line_end}` : ''}
        </div>
      </div>

      {ticket.description && (
        <div>
          <div className="font-medium text-[var(--text-secondary)] mb-1">Description</div>
          <div className="text-[var(--text-primary)] whitespace-pre-wrap">{ticket.description.slice(0, 500)}</div>
        </div>
      )}

      {ticket.source.code_snippet && (
        <div>
          <div className="font-medium text-[var(--text-secondary)] mb-1">Code</div>
          <pre className="rounded bg-black/30 p-2 text-[10px] overflow-x-auto font-mono whitespace-pre-wrap">
            {ticket.source.code_snippet.slice(0, 300)}
          </pre>
        </div>
      )}

      {ticket.suggestion && (
        <div>
          <div className="font-medium text-[var(--text-secondary)] mb-1">Suggestion</div>
          <div className="text-[var(--text-primary)]">{ticket.suggestion}</div>
        </div>
      )}

      {ticket.notes && ticket.notes.length > 0 && (
        <div>
          <div className="font-medium text-[var(--text-secondary)] mb-1">Notes ({ticket.notes.length})</div>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {ticket.notes.slice(-5).map((note, i) => (
              <div key={i} className="text-[var(--text-secondary)] text-[10px]">
                <span className="text-[var(--text-tertiary)]">{new Date(note.timestamp).toLocaleDateString()}</span>
                {' '}{note.content.slice(0, 100)}
              </div>
            ))}
          </div>
        </div>
      )}

      {isBlocked && (
        <div className="rounded bg-red-900/20 border border-red-800/30 px-2 py-1 text-red-400">
          Blocked — failed 3+ times without source change
        </div>
      )}

      <div className="flex gap-2 pt-1 border-t border-[var(--border)]">
        {isFixable && !isBlocked && (
          <button
            onClick={() => dispatchFix(ticket.id)}
            disabled={dispatchingTicketId === ticket.id}
            className="rounded border border-accent/50 bg-accent/10 px-3 py-1 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {dispatchingTicketId === ticket.id ? 'Dispatching...' : 'Fix Now'}
          </button>
        )}
        {ticket.status === 'open' && (
          <button
            onClick={() => transitionTicket(ticket.id, 'rejected')}
            className="rounded border border-[var(--border)] px-3 py-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            Dismiss
          </button>
        )}
        {isBlocked && (
          <button
            onClick={() => transitionTicket(ticket.id, 'open')}
            className="rounded border border-yellow-800/50 bg-yellow-900/20 px-3 py-1 text-yellow-400 hover:bg-yellow-900/30 transition-colors"
          >
            Unblock
          </button>
        )}
      </div>
    </div>
  )
}
