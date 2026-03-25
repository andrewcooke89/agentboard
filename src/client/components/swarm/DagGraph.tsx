import { useMemo } from 'react'
import type { SwarmWoState, WoStatus } from '@shared/swarmTypes'

export interface DagGraphProps {
  wos: Record<string, SwarmWoState>
  edges: Array<{ from: string; to: string }>
  selectedWoId: string | null
  onSelectWo: (woId: string) => void
}

const NODE_WIDTH = 160
const NODE_HEIGHT = 50
const HORIZONTAL_SPACING = 220
const VERTICAL_SPACING = 70
const PADDING = 32
const CURVE_OFFSET = 60
const MAX_LABEL_LENGTH = 18

const STATUS_COLORS: Record<WoStatus, string> = {
  pending: '#374151',
  ready: '#1e3a5f',
  running: '#1e40af',
  completed: '#166534',
  failed: '#991b1b',
  escalated: '#92400e',
}

interface PositionedNode {
  woId: string
  x: number
  y: number
  layer: number
}

interface LayoutResult {
  nodes: PositionedNode[]
  width: number
  height: number
  viewBox: string
  hasCycle: boolean
}

function truncateLabel(value: string): string {
  if (value.length <= MAX_LABEL_LENGTH) {
    return value
  }

  return `${value.slice(0, MAX_LABEL_LENGTH - 1)}…`
}

function topologicalOrder(
  nodeIds: string[],
  edges: Array<{ from: string; to: string }>
): { ordered: string[]; hasCycle: boolean } {
  const adjacency = new Map<string, string[]>()
  const inDegree = new Map<string, number>()

  for (const nodeId of nodeIds) {
    adjacency.set(nodeId, [])
    inDegree.set(nodeId, 0)
  }

  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to)
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
  }

  const queue = nodeIds.filter((nodeId) => (inDegree.get(nodeId) ?? 0) === 0).sort()
  const ordered: string[] = []

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      break
    }

    ordered.push(current)

    for (const next of adjacency.get(current) ?? []) {
      const nextDegree = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, nextDegree)
      if (nextDegree === 0) {
        queue.push(next)
        queue.sort()
      }
    }
  }

  if (ordered.length === nodeIds.length) {
    return { ordered, hasCycle: false }
  }

  const remaining = nodeIds.filter((nodeId) => !ordered.includes(nodeId)).sort()
  return { ordered: [...ordered, ...remaining], hasCycle: true }
}

function computeLayout(wos: Record<string, SwarmWoState>, edges: Array<{ from: string; to: string }>): LayoutResult {
  const nodeIds = Object.keys(wos).sort()

  if (nodeIds.length === 0) {
    return {
      nodes: [],
      width: 0,
      height: 0,
      viewBox: '0 0 0 0',
      hasCycle: false,
    }
  }

  const nodeIdSet = new Set(nodeIds)
  const validEdges = edges.filter((edge) => nodeIdSet.has(edge.from) && nodeIdSet.has(edge.to))
  const { ordered, hasCycle } = topologicalOrder(nodeIds, validEdges)
  const incoming = new Map<string, string[]>()

  for (const nodeId of nodeIds) {
    incoming.set(nodeId, [])
  }

  for (const edge of validEdges) {
    incoming.get(edge.to)?.push(edge.from)
  }

  const layerByNode = new Map<string, number>()

  for (const nodeId of ordered) {
    const dependencies = incoming.get(nodeId) ?? []
    const layer =
      dependencies.length === 0
        ? 0
        : Math.max(...dependencies.map((dependencyId) => layerByNode.get(dependencyId) ?? 0)) + 1
    layerByNode.set(nodeId, layer)
  }

  const layers = new Map<number, string[]>()
  for (const nodeId of ordered) {
    const layer = layerByNode.get(nodeId) ?? 0
    const layerNodes = layers.get(layer) ?? []
    layerNodes.push(nodeId)
    layers.set(layer, layerNodes)
  }

  for (const layerNodes of layers.values()) {
    layerNodes.sort((left, right) => left.localeCompare(right))
  }

  const tallestLayerSize = Math.max(...Array.from(layers.values(), (layerNodes) => layerNodes.length))
  const contentHeight = NODE_HEIGHT + Math.max(0, tallestLayerSize - 1) * VERTICAL_SPACING
  const nodes: PositionedNode[] = []
  let minX = 0
  let minY = 0
  let maxX = NODE_WIDTH
  let maxY = NODE_HEIGHT

  for (const [layer, layerNodes] of Array.from(layers.entries()).sort((a, b) => a[0] - b[0])) {
    const layerHeight = NODE_HEIGHT + Math.max(0, layerNodes.length - 1) * VERTICAL_SPACING
    const verticalOffset = (contentHeight - layerHeight) / 2

    layerNodes.forEach((woId, index) => {
      const x = layer * HORIZONTAL_SPACING
      const y = verticalOffset + index * VERTICAL_SPACING
      nodes.push({ woId, x, y, layer })
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + NODE_WIDTH)
      maxY = Math.max(maxY, y + NODE_HEIGHT)
    })
  }

  const width = maxX - minX + PADDING * 2
  const height = Math.max(contentHeight, maxY - minY) + PADDING * 2

  return {
    nodes,
    width,
    height,
    viewBox: `${minX - PADDING} ${minY - PADDING} ${width} ${height}`,
    hasCycle,
  }
}

function buildEdgePath(from: PositionedNode, to: PositionedNode): string {
  const startX = from.x + NODE_WIDTH
  const startY = from.y + NODE_HEIGHT / 2
  const endX = to.x
  const endY = to.y + NODE_HEIGHT / 2

  return `M ${startX} ${startY} C ${startX + CURVE_OFFSET} ${startY} ${endX - CURVE_OFFSET} ${endY} ${endX} ${endY}`
}

function edgeColor(sourceStatus: WoStatus | undefined, targetStatus: WoStatus | undefined): string {
  if (sourceStatus === 'completed' && targetStatus === 'completed') {
    return '#166534'
  }

  if (targetStatus === 'running') {
    return '#3B82F6'
  }

  return '#4B5563'
}

export default function DagGraph({ wos, edges, selectedWoId, onSelectWo }: DagGraphProps) {
  const layout = useMemo(() => computeLayout(wos, edges), [wos, edges])

  const positionedNodes = useMemo(() => {
    return new Map(layout.nodes.map((node) => [node.woId, node]))
  }, [layout.nodes])

  if (layout.nodes.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center overflow-auto text-sm text-gray-500" role="status">
        No active swarm
      </div>
    )
  }

  return (
    <div className="w-full h-full overflow-auto">
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={layout.viewBox}
        role="img"
        aria-label="Swarm work order dependency graph"
        style={{ display: 'block', minWidth: layout.width, minHeight: layout.height }}
      >
        <defs>
          <marker
            id="dag-graph-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
          </marker>
        </defs>

        {edges.map((edge) => {
          const source = positionedNodes.get(edge.from)
          const target = positionedNodes.get(edge.to)

          if (!source || !target) {
            return null
          }

          const stroke = edgeColor(wos[edge.from]?.status, wos[edge.to]?.status)

          return (
            <path
              key={`${edge.from}-${edge.to}`}
              d={buildEdgePath(source, target)}
              fill="none"
              stroke={stroke}
              strokeWidth={2}
              markerEnd="url(#dag-graph-arrow)"
              style={{ transition: 'stroke 160ms ease' }}
            />
          )
        })}

        {layout.nodes.map((node) => {
          const wo = wos[node.woId]
          const isSelected = selectedWoId === node.woId
          const tier = wo.escalationTier
          const fill = STATUS_COLORS[wo.status]

          return (
            <g
              key={node.woId}
              transform={`translate(${node.x}, ${node.y})`}
              onClick={() => onSelectWo(node.woId)}
              style={{ cursor: 'pointer' }}
            >
              <title>{wo.title || node.woId}</title>
              <rect
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={8}
                fill={fill}
                stroke={isSelected ? '#ffffff' : 'transparent'}
                strokeWidth={isSelected ? 2 : 0}
                style={wo.status === 'running' ? { animation: 'pulse 1.5s ease-in-out infinite' } : undefined}
              />
              <text
                x={NODE_WIDTH / 2}
                y={NODE_HEIGHT / 2}
                fill="#ffffff"
                fontSize="12"
                textAnchor="middle"
                dominantBaseline="middle"
                pointerEvents="none"
              >
                {truncateLabel(node.woId)}
              </text>
              {tier > 0 && (
                <>
                  <circle cx={NODE_WIDTH - 14} cy={14} r={9} fill="#111827" stroke="#ffffff" strokeWidth={1} />
                  <text
                    x={NODE_WIDTH - 14}
                    y={14}
                    fill="#ffffff"
                    fontSize="10"
                    fontWeight="700"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    pointerEvents="none"
                  >
                    {tier}
                  </text>
                </>
              )}
            </g>
          )
        })}
        {layout.hasCycle && (
          <text x={0} y={-10} fill="#f59e0b" fontSize="11" textAnchor="start">
            Dependency cycle detected. Layout may be approximate.
          </text>
        )}
      </svg>
    </div>
  )
}
