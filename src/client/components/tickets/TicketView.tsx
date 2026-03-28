import { useEffect } from 'react'
import { useTicketStore } from '../../stores/ticketStore'
import TicketStatsBar from './TicketStatsBar'
import NightlyReportCard from './NightlyReportCard'
import TicketFilters from './TicketFilters'
import TicketTable from './TicketTable'
import TicketDetail from './TicketDetail'

export default function TicketView() {
  const selectedTicketId = useTicketStore(s => s.selectedTicketId)

  useEffect(() => {
    useTicketStore.getState().fetchTickets()
    useTicketStore.getState().fetchStats()
    useTicketStore.getState().fetchReports()
  }, [])

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <div className="flex-none p-4 pb-0 space-y-3">
        <TicketStatsBar />
        <NightlyReportCard />
        <TicketFilters />
      </div>
      <div className="flex flex-1 min-h-0 p-4 gap-4">
        <div className="flex-1 overflow-y-auto">
          <TicketTable />
        </div>
        {selectedTicketId && (
          <div className="w-80 flex-none overflow-y-auto">
            <TicketDetail />
          </div>
        )}
      </div>
    </div>
  )
}
