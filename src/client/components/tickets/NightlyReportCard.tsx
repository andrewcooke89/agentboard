import { useState } from 'react'
import { useTicketStore } from '../../stores/ticketStore'

export default function NightlyReportCard() {
  const latestReport = useTicketStore(s => s.latestReport)
  const reports = useTicketStore(s => s.reports)
  const [expanded, setExpanded] = useState(false)

  if (!latestReport) {
    return (
      <div className="rounded border border-[var(--border)] bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-secondary)]">
        No nightly reports yet
      </div>
    )
  }

  const r = latestReport

  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg-base)]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-[var(--bg-hover)] transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="font-medium">Last Run: {r.date}</span>
          <span className="text-[var(--text-secondary)]">{r.durationMinutes}m</span>
          <span className="text-[var(--text-secondary)]">{r.fix.cycles} cycles</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-green-400">{r.fix.fixed} fixed</span>
          {r.fix.failed > 0 && <span className="text-red-400">{r.fix.failed} failed</span>}
          {r.fix.skipped_blocked > 0 && <span className="text-orange-400">{r.fix.skipped_blocked} blocked</span>}
          <span className="text-[var(--text-secondary)]">{expanded ? '▴' : '▾'}</span>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-[var(--border)] px-3 py-2 text-xs space-y-2">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            <div>Detect: {r.detect.findings_total} findings, {r.detect.tickets_created} new tickets</div>
            <div>Stale resolved: {r.detect.tickets_stale_resolved}</div>
            <div>Small: {r.fix.small.succeeded}/{r.fix.small.dispatched} succeeded</div>
            <div>Medium: {r.fix.medium.succeeded}/{r.fix.medium.dispatched} succeeded</div>
            <div>Backlog: {r.backlog.total_open} open</div>
            <div>Blocked: {r.backlog.blocked}</div>
          </div>
          {r.fix.prs_opened.length > 0 && (
            <div>
              PRs: {r.fix.prs_opened.map((pr, _i) => (
                <a key={pr} href={pr} target="_blank" rel="noopener" className="text-accent hover:underline ml-1">{pr.split('/').pop()}</a>
              ))}
            </div>
          )}
          {r.notable_failures.length > 0 && (
            <div>
              <div className="font-medium text-red-400 mb-1">Failures:</div>
              {r.notable_failures.map((f) => (
                <div key={f.ticket_id} className="text-[var(--text-secondary)]">
                  {f.ticket_id}: {f.title.slice(0, 60)} — {f.reason}
                </div>
              ))}
            </div>
          )}
          {reports.length > 1 && (
            <div className="border-t border-[var(--border)] pt-2 mt-2">
              <div className="font-medium mb-1">Recent runs:</div>
              {reports.slice(1, 7).map((rep) => (
                <div key={rep.date} className="flex justify-between text-[var(--text-secondary)]">
                  <span>{rep.date}</span>
                  <span>{rep.fix.fixed} fixed, {rep.fix.failed} failed, {rep.backlog.total_open} open</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
