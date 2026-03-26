import { SwarmEvent } from '../../shared/swarmTypes'

interface SwarmStore {
  eventLog: SwarmEvent[]
  addEvent: (event: SwarmEvent) => void
  clearEvents: () => void
}

export const swarmStore: SwarmStore = {
  eventLog: [],
  
  addEvent: (event: SwarmEvent) => {
    swarmStore.eventLog.push(event)
  },
  
  clearEvents: () => {
    swarmStore.eventLog = []
  }
}
