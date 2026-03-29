import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { AgentSession, Session } from '@shared/types'
import { getPathLeaf } from '../utils/sessionLabel'

export function useSessionFiltering(
  sortedSessions: Session[],
  inactiveSessions: AgentSession[],
  sessions: Session[],
  projectFilters: string[],
  searchQuery: string,
  sessionGroupMode: string,
  newlyActiveIds: Set<string>,
) {
  // Helper function to check if a session matches search query
  const matchesSearch = useCallback((session: Session | AgentSession, query: string): boolean => {
    if (!query) return true
    const lowerQuery = query.toLowerCase()

    // For Session type
    if ('name' in session) {
      const name = session.name?.toLowerCase() || ''
      const agentSessionName = session.agentSessionName?.toLowerCase() || ''
      const projectPath = session.projectPath?.toLowerCase() || ''
      const lastUserMessage = session.lastUserMessage?.toLowerCase() || ''
      const projectLeaf = getPathLeaf(session.projectPath)?.toLowerCase() || ''

      return (
        name.includes(lowerQuery) ||
        agentSessionName.includes(lowerQuery) ||
        projectPath.includes(lowerQuery) ||
        projectLeaf.includes(lowerQuery) ||
        lastUserMessage.includes(lowerQuery)
      )
    }

    // For AgentSession type
    const displayName = session.displayName?.toLowerCase() || ''
    const projectPath = session.projectPath?.toLowerCase() || ''
    const lastUserMessage = session.lastUserMessage?.toLowerCase() || ''
    const projectLeaf = getPathLeaf(session.projectPath)?.toLowerCase() || ''

    return (
      displayName.includes(lowerQuery) ||
      projectPath.includes(lowerQuery) ||
      projectLeaf.includes(lowerQuery) ||
      lastUserMessage.includes(lowerQuery)
    )
  }, [])

  const filteredSessions = useMemo(() => {
    let result = sortedSessions

    // Apply project filter
    if (projectFilters.length === 0) {
      result = sortedSessions
    } else {
      result = sortedSessions.filter((session) => projectFilters.includes(session.projectPath))
    }

    // Apply search filter
    if (searchQuery.trim()) {
      result = result.filter((session) => matchesSearch(session, searchQuery))
    }

    return result
  }, [sortedSessions, projectFilters, searchQuery, matchesSearch])

  const filterKey = useMemo(
    () => (projectFilters.length === 0 ? 'all-projects' : projectFilters.join('|')),
    [projectFilters]
  )

  const groupedSessions = useMemo(() => {
    if (sessionGroupMode !== 'project') return null
    const groups: { projectPath: string; projectName: string; sessions: typeof filteredSessions }[] = []
    const groupMap = new Map<string, typeof filteredSessions>()
    for (const session of filteredSessions) {
      const existing = groupMap.get(session.projectPath)
      if (existing) {
        existing.push(session)
      } else {
        const arr = [session]
        groupMap.set(session.projectPath, arr)
        groups.push({
          projectPath: session.projectPath,
          projectName: getPathLeaf(session.projectPath) || session.projectPath,
          sessions: arr,
        })
      }
    }
    return groups
  }, [filteredSessions, sessionGroupMode])

  // Track sessions that became visible due to filter changes (for entry animation)
  const prevFilteredIdsRef = useRef<Set<string>>(new Set(filteredSessions.map((s) => s.id)))
  const [newlyFilteredInIds, setNewlyFilteredInIds] = useState<Set<string>>(() => new Set())

  // Detect sessions that became visible due to filter changes
  useEffect(() => {
    const currentFilteredIds = new Set(filteredSessions.map((s) => s.id))
    const newlyVisible = new Set<string>()

    // Find sessions that are now visible but weren't before
    for (const id of currentFilteredIds) {
      if (!prevFilteredIdsRef.current.has(id)) {
        // Only mark as "newly filtered in" if the session already existed (wasn't truly new)
        // This distinguishes filter changes from actual new sessions
        if (!newlyActiveIds.has(id)) {
          newlyVisible.add(id)
        }
      }
    }

    prevFilteredIdsRef.current = currentFilteredIds

    if (newlyVisible.size > 0) {
      setNewlyFilteredInIds(newlyVisible)
    }
  }, [filteredSessions, newlyActiveIds])

  // Auto-clear newlyFilteredInIds after delay (separate effect to avoid timer bugs)
  useEffect(() => {
    if (newlyFilteredInIds.size === 0) return
    const timer = setTimeout(() => setNewlyFilteredInIds(new Set()), 500)
    return () => clearTimeout(timer)
  }, [newlyFilteredInIds])

  const filteredInactiveSessions = useMemo(() => {
    let result = inactiveSessions

    // Apply project filter
    if (projectFilters.length > 0) {
      result = result.filter((session) => projectFilters.includes(session.projectPath))
    }

    // Apply search filter
    if (searchQuery.trim()) {
      result = result.filter((session) => matchesSearch(session, searchQuery))
    }

    return result
  }, [inactiveSessions, projectFilters, searchQuery, matchesSearch])

  const hiddenPermissionCount = useMemo(() => {
    if (projectFilters.length === 0) return 0
    const filterSet = new Set(projectFilters)
    return sessions.filter(
      (session) =>
        !filterSet.has(session.projectPath) && session.status === 'permission'
    ).length
  }, [sessions, projectFilters])

  const totalActiveSessions = useMemo(() => {
    let count = sortedSessions.length
    if (projectFilters.length > 0) {
      count = sortedSessions.filter((s) => projectFilters.includes(s.projectPath)).length
    }
    return count
  }, [sortedSessions, projectFilters])

  return {
    matchesSearch,
    filteredSessions,
    filterKey,
    groupedSessions,
    filteredInactiveSessions,
    hiddenPermissionCount,
    totalActiveSessions,
    newlyFilteredInIds,
  }
}
