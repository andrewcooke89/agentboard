// LogMetadataExtractor.ts - Extract metadata from JSONL log files
import { open } from 'node:fs/promises'

export interface LogMetadata {
  messageCount: number
  firstMessage?: string
  sessionType: 'original' | 'trimmed' | 'rollover' | 'sub-agent' | 'unknown'
}

const MAX_READ_BYTES = 65536 // 64KB
const MAX_READ_LINES = 200

/**
 * Extract metadata from a JSONL log file by reading a bounded amount.
 * Reads at most MAX_READ_BYTES or MAX_READ_LINES from the start of the file.
 * Uses async I/O to avoid blocking the event loop during search operations.
 */
export async function extractLogMetadata(
  filePath: string,
  maxBytes = MAX_READ_BYTES,
  maxLines = MAX_READ_LINES,
): Promise<LogMetadata> {
  const result: LogMetadata = {
    messageCount: 0,
    sessionType: 'unknown',
  }

  let fileHandle: Awaited<ReturnType<typeof open>> | undefined
  try {
    fileHandle = await open(filePath, 'r')
    const buffer = Buffer.alloc(Math.min(maxBytes, 65536))
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0)
    const content = buffer.subarray(0, bytesRead).toString('utf-8')

    const lines = content.split('\n').slice(0, maxLines)
    let messageCount = 0
    let firstUserMessage: string | undefined

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const entry = JSON.parse(trimmed)

        // Count messages
        if (entry.type === 'human' || entry.type === 'assistant' || entry.role === 'user' || entry.role === 'assistant') {
          messageCount++
        }

        // Extract first user message
        if (!firstUserMessage) {
          if (entry.type === 'human' && typeof entry.message === 'string') {
            firstUserMessage = entry.message.slice(0, 200)
          } else if (entry.role === 'user' && typeof entry.content === 'string') {
            firstUserMessage = entry.content.slice(0, 200)
          } else if (entry.type === 'human' && entry.message?.content) {
            let text = ''
            if (typeof entry.message.content === 'string') {
              text = entry.message.content
            } else if (Array.isArray(entry.message.content)) {
              text = entry.message.content.find((b: any) => b.type === 'text')?.text ?? ''
            }
            if (text) firstUserMessage = text.slice(0, 200)
          }
        }

        // Detect session type
        if (entry.type === 'system' && entry.subtype === 'trimmed') {
          result.sessionType = 'trimmed'
        } else if (entry.type === 'system' && entry.subtype === 'rollover') {
          result.sessionType = 'rollover'
        } else if (entry.parentSessionId || entry.parent_session_id) {
          result.sessionType = 'sub-agent'
        } else if (messageCount > 0 && result.sessionType === 'unknown') {
          result.sessionType = 'original'
        }
      } catch {
        // Skip unparseable lines
        console.error('Failed to parse log line:', trimmed)
      }
    }

    result.messageCount = messageCount
    if (firstUserMessage) result.firstMessage = firstUserMessage
  } catch (error) {
    // Return defaults on read error
    console.error('Failed to read log file:', error)
  } finally {
    if (fileHandle) {
      try { await fileHandle.close() } catch { /* ignore */ }
    }
  }

  return result
}
