import { useSwarmStore } from '../../stores/swarmStore'
import DagGraph from './DagGraph'
import GroupProgress from './GroupProgress'
import WoDetail from './WoDetail'

export default function SwarmView() {
  const {
    groups,
    selectedGroupId,
    selectedWoId,
    selectGroup,
    selectWo,
  } = useSwarmStore()

  const selectedGroup = groups.find((group) => group.groupId === selectedGroupId) || groups[0] || null
  const selectedWo =
    selectedGroup && selectedWoId
      ? selectedGroup.wos[selectedWoId] || null
      : null
  const activeGroupId = selectedGroup?.groupId ?? selectedGroupId

  return (
    <div className="flex h-full flex-col bg-[#0a0a1a]">
      {groups.length > 1 && (
        <div className="flex gap-1 border-b border-gray-800 px-4 pt-2">
          {groups.map((group) => (
            <button
              key={group.groupId}
              onClick={() => selectGroup(group.groupId)}
              className={`px-3 py-1 text-xs rounded-t ${
                group.groupId === activeGroupId
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {group.groupId}
            </button>
          ))}
        </div>
      )}

      <div className="border-b border-gray-800 px-4 py-2">
        <GroupProgress group={selectedGroup} />
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex-1 overflow-auto">
          <DagGraph
            wos={selectedGroup?.wos || {}}
            edges={selectedGroup?.edges || []}
            selectedWoId={selectedWoId}
            onSelectWo={selectWo}
          />
        </div>
        <div className="w-80 overflow-auto border-l border-gray-800">
          <WoDetail wo={selectedWo} />
        </div>
      </div>
    </div>
  )
}
