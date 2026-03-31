import { useTicketStore } from '../../stores/ticketStore'

const STATUS_OPTIONS = ['', 'open', 'in-progress', 'validated', 'resolved', 'duplicate', 'rejected']
const EFFORT_OPTIONS = ['', 'small', 'medium', 'large']
const CATEGORY_OPTIONS = ['', 'error-handling', 'performance', 'dead-code', 'security', 'style', 'testing', 'maintainability', 'deprecated']
const SEVERITY_OPTIONS = ['', 'critical', 'high', 'medium', 'low', 'info']

export default function TicketFilters() {
  const filters = useTicketStore(s => s.filters)
  const setFilters = useTicketStore(s => s.setFilters)
  const totalCount = useTicketStore(s => s.totalCount)
  const loading = useTicketStore(s => s.loading)

  return (
    <div className="flex items-center gap-3 text-sm">
      <FilterSelect label="Status" value={filters.status} options={STATUS_OPTIONS}
        onChange={v => setFilters({ status: v })} />
      <FilterSelect label="Effort" value={filters.effort} options={EFFORT_OPTIONS}
        onChange={v => setFilters({ effort: v })} />
      <FilterSelect label="Category" value={filters.category} options={CATEGORY_OPTIONS}
        onChange={v => setFilters({ category: v })} />
      <FilterSelect label="Severity" value={filters.severity} options={SEVERITY_OPTIONS}
        onChange={v => setFilters({ severity: v })} />
      <span className="ml-auto text-xs text-[var(--text-secondary)]">
        {loading ? 'Loading...' : `${totalCount} total`}
      </span>
    </div>
  )
}

function FilterSelect({ label, value, options, onChange }: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <label className="flex items-center gap-1 text-[var(--text-secondary)]">
      {label}:
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="rounded border border-[var(--border)] bg-[var(--bg-base)] px-1.5 py-0.5 text-[var(--text-primary)] text-xs"
      >
        {options.map(o => (
          <option key={o} value={o}>{o || 'All'}</option>
        ))}
      </select>
    </label>
  )
}
