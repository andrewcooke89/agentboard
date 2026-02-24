// CronScriptTab.tsx — Read-only syntax-highlighted script viewer
// WU-014: Script Tab & Job Controls
//
// Language auto-detected from extension (REQ-34).
// Line numbers, file path breadcrumb, Open in Terminal button (REQ-36).
// Falls back to raw command code block for inline commands (REQ-35).
// Simple comment-line syntax highlighting (no external deps required).

import React from 'react'
import type { CronJob, CronJobDetail } from '../../../shared/types'

interface CronScriptTabProps {
  job: CronJob
  detail: CronJobDetail | null
}

// ── Language detection ────────────────────────────────────────────────────────

const EXTENSION_MAP: Record<string, string> = {
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  rb: 'ruby',
  pl: 'perl',
  php: 'php',
  lua: 'lua',
  r: 'r',
}

function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_MAP[ext] ?? 'shell'
}

// ── Simple syntax highlighter ─────────────────────────────────────────────────
// Highlights comment lines (starting with # or //) in muted color.
// Strings are not parsed; this is intentionally minimal.

function renderCodeLine(line: string, lang: string): React.ReactNode {
  const isComment =
    /^\s*(#|\/\/)/.test(line) ||
    (lang === 'python' && /^\s*"""/.test(line))

  if (isComment) {
    return <span className="text-zinc-500">{line || '\u00A0'}</span>
  }

  // Highlight keywords for common languages
  const keywords: Record<string, RegExp | null> = {
    bash: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|export|local|readonly|source|declare)\b/g,
    python: /\b(def|class|return|import|from|if|elif|else|for|while|try|except|finally|with|as|pass|break|continue|lambda|yield|raise|True|False|None|and|or|not|in|is)\b/g,
    javascript: /\b(const|let|var|function|return|if|else|for|while|class|import|export|default|async|await|try|catch|finally|new|this|typeof|instanceof|null|undefined|true|false)\b/g,
    typescript: /\b(const|let|var|function|return|if|else|for|while|class|import|export|default|async|await|try|catch|finally|new|this|typeof|instanceof|null|undefined|true|false|interface|type|enum|extends|implements|readonly|public|private|protected)\b/g,
    ruby: /\b(def|end|class|module|return|if|elsif|else|unless|while|for|do|begin|rescue|ensure|raise|yield|self|nil|true|false|puts|require|include|attr_accessor|attr_reader|attr_writer)\b/g,
    perl: /\b(my|local|our|sub|return|if|elsif|else|unless|while|for|foreach|do|use|require|package|push|pop|shift|unshift|print|say)\b/g,
  }

  const pattern = keywords[lang] ?? null
  if (!pattern) return <span>{line || '\u00A0'}</span>

  // Reset lastIndex for stateful regex
  pattern.lastIndex = 0
  const parts: React.ReactNode[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIdx) {
      parts.push(line.slice(lastIdx, match.index))
    }
    parts.push(
      <span key={match.index} className="text-blue-400">
        {match[0]}
      </span>,
    )
    lastIdx = match.index + match[0].length
  }
  if (lastIdx < line.length) parts.push(line.slice(lastIdx))

  return <span>{parts.length > 0 ? parts : (line || '\u00A0')}</span>
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────

function Breadcrumb({ path }: { path: string }) {
  const parts = path.replace(/^~/, '~').split('/')
  return (
    <div className="flex items-center gap-1 text-xs text-zinc-500 font-mono min-w-0 flex-1 truncate">
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="text-zinc-700">/</span>}
          <span className={i === parts.length - 1 ? 'text-zinc-300' : 'text-zinc-500'}>
            {part}
          </span>
        </React.Fragment>
      ))}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CronScriptTab({ job, detail }: CronScriptTabProps) {
  const scriptPath = detail?.scriptPath ?? job.scriptPath
  const scriptContent = detail?.scriptContent
  const lang = scriptPath ? detectLanguage(scriptPath) : 'shell'

  const lines = scriptContent ? scriptContent.split('\n') : null

  // Fallback: show raw command
  if (!lines) {
    const cmdLines = job.command.split('\n')
    return (
      <div className="flex flex-col h-full min-h-0">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 shrink-0">
          <span className="text-xs text-zinc-500">Command</span>
          {scriptPath && (
            <>
              <span className="text-zinc-700">·</span>
              <Breadcrumb path={scriptPath} />
            </>
          )}
        </div>

        {/* Raw command fallback */}
        <div className="flex-1 overflow-y-auto bg-zinc-900 min-h-0">
          <table className="w-full border-collapse font-mono text-xs text-zinc-300">
            <tbody>
              {cmdLines.map((line, i) => (
                <tr key={i} className="hover:bg-zinc-800/50">
                  <td className="text-right text-zinc-600 select-none pr-3 pl-3 py-0 w-10 align-top whitespace-nowrap">
                    {i + 1}
                  </td>
                  <td className="pr-3 py-0 align-top break-all whitespace-pre-wrap">
                    {line || '\u00A0'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Breadcrumb + actions */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 shrink-0">
        {scriptPath ? (
          <Breadcrumb path={scriptPath} />
        ) : (
          <span className="text-xs text-zinc-500">Script</span>
        )}

        <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400 border border-zinc-600 shrink-0">
          {lang}
        </span>

        {scriptPath && (
          <button
            onClick={() => {
              // Placeholder: display the path in a tooltip-style alert.
              // A real implementation would open a terminal and run the script.
              window.prompt('Open in Terminal — script path:', scriptPath)
            }}
            className="text-xs px-2 py-1 rounded bg-zinc-700 text-zinc-300 border border-zinc-600 hover:bg-zinc-600 transition-colors shrink-0"
            title="Open in Terminal"
          >
            Open in Terminal
          </button>
        )}
      </div>

      {/* Code viewer */}
      <div className="flex-1 overflow-auto bg-zinc-900 min-h-0">
        <table className="w-full border-collapse font-mono text-xs text-zinc-300">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-zinc-800/50">
                <td className="text-right text-zinc-600 select-none pr-3 pl-3 py-0 w-10 align-top whitespace-nowrap">
                  {i + 1}
                </td>
                <td className="pr-3 py-0 align-top whitespace-pre-wrap break-all">
                  {renderCodeLine(line, lang)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
