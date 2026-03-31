import { useMemo } from 'react'
import type { SwarmWoState, WoStatus } from '../../../shared/swarmTypes'

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
const SVG_BACKGROUND = '#0f172a'

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
  validEdges: Array<{ from: string; to: string }>
  width: number
  height: number
  viewBox: string
  hasCycle: boolean
}

function truncateLabel(value: string): string {
  if (value.length <= MAX_LABEL_LENGTH) {
    return value
  }

  return `${value.slice(0, MAX_LABEL_LENGTH - 1)}...`
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
      validEdges: [],
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

  const tallestLayerSize = Math.max(...Array.from(layers.values(), (layerNodes) => layerNodes.length))
  const tallestLayerHeight = NODE_HEIGHT + Math.max(0, tallestLayerSize - 1) * VERTICAL_SPACING
  const nodes: PositionedNode[] = []

  for (const [layer, layerNodes] of Array.from(layers.entries()).sort((left, right) => left[0] - right[0])) {
    layerNodes.sort((left, right) => left.localeCompare(right))
    const layerHeight = NODE_HEIGHT + Math.max(0, layerNodes.length - 1) * VERTICAL_SPACING
    const verticalOffset = (tallestLayerHeight - layerHeight) / 2

    layerNodes.forEach((woId, index) => {
      nodes.push({
        woId,
        layer,
        x: layer * HORIZONTAL_SPACING,
        y: verticalOffset + index * VERTICAL_SPACING,
      })
    })
  }

  const maxLayer = Math.max(...nodes.map((node) => node.layer))
  const width = maxLayer * HORIZONTAL_SPACING + NODE_WIDTH + PADDING * 2
  const height = tallestLayerHeight + PADDING * 2

  return {
    nodes,
    validEdges,
    width,
    height,
    viewBox: `${-PADDING} ${-PADDING} ${width} ${height}`,
    hasCycle,
  }
}

function buildEdgePath(from: PositionedNode, to: PositionedNode): string {
  const startX = from.x + NODE_WIDTH
  const startY = from.y + NODE_HEIGHT / 2
  const endX = to.x
  const endY = to.y + NODE_HEIGHT / 2
  const controlOffset = Math.min(CURVE_OFFSET, Math.max((endX - startX) / 2, 20))

  return `M ${startX} ${startY} C ${startX + controlOffset} ${startY} ${endX - controlOffset} ${endY} ${endX} ${endY}`
}

function getEdgeColor(sourceStatus: WoStatus | undefined, targetStatus: WoStatus | undefined): string {
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
      <div className="flex h-full min-h-[320px] w-full items-center justify-center overflow-auto rounded-lg border border-white/10 bg-[#1a1a2e] text-sm text-gray-500">
        No active swarm
      </div>
    )
  }

  return (
    <div className="h-full w-full overflow-auto rounded-lg border border-white/10 bg-[#1a1a2e]">
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={layout.viewBox}
        role="img"
        aria-label="Swarm work order dependency graph"
        style={{ display: 'block', minWidth: layout.width, minHeight: layout.height, background: SVG_BACKGROUND }}
      >
        <defs>
          <marker
            id="dag-graph-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
          </marker>
        </defs>
        <style>
          {`
            @keyframes dagNodePulse {
              0% { opacity: 0.88; }
              50% { opacity: 1; }
              100% { opacity: 0.88; }
            }
          `}
        </style>

        {layout.validEdges.map((edge) => {
          const source = positionedNodes.get(edge.from)
          const target = positionedNodes.get(edge.to)

          if (!source || !target) {
            return null
          }

          const stroke = getEdgeColor(wos[edge.from]?.status, wos[edge.to]?.status)

          return (
            <path
              key={`${edge.from}-${edge.to}`}
              d={buildEdgePath(source, target)}
              fill="none"
              stroke={stroke}
              strokeWidth={2}
              markerEnd="url(#dag-graph-arrow)"
              opacity={0.95}
            />
          )
        })}

        {layout.nodes.map((node) => {
          const wo = wos[node.woId]
          const isSelected = selectedWoId === node.woId
          const tier = wo.escalationTier

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
                fill={STATUS_COLORS[wo.status]}
                stroke={isSelected ? '#ffffff' : 'rgba(255,255,255,0.12)'}
                strokeWidth={isSelected ? 2 : 1}
                style={wo.status === 'running' ? { animation: 'dagNodePulse 1.5s ease-in-out infinite' } : undefined}
              />
              <text
                x={NODE_WIDTH / 2}
                y={NODE_HEIGHT / 2}
                fill="#ffffff"
                fontSize="12"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace"
                textAnchor="middle"
                dominantBaseline="middle"
                pointerEvents="none"
              >
                {truncateLabel(node.woId)}
              </text>
              {tier > 0 ? (
                <>
                  <circle cx={NODE_WIDTH - 14} cy={14} r={9} fill="#0b1220" stroke="#ffffff" strokeWidth={1} />
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
              ) : null}
            </g>
          )
        })}

        {layout.hasCycle ? (
          <text x={0} y={-10} fill="#f59e0b" fontSize="11" textAnchor="start">
            Dependency cycle detected. Layout may be approximate.
          </text>
        ) : null}
      </svg>
    </div>
  )
}
