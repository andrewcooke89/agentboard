// WU-012: Detail Pane & Overview Tab — CronScriptTab

import React, { useMemo } from 'react'
import { useCronStore } from '../../stores/cronStore'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import ruby from 'highlight.js/lib/languages/ruby'
import perl from 'highlight.js/lib/languages/perl'
import 'highlight.js/styles/github-dark.css'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('python', python)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('perl', perl)

// ─── Language detection ───────────────────────────────────────────────────────

function detectLanguage(scriptLanguage: string | null, scriptPath: string | null): string {
  if (scriptLanguage) return scriptLanguage.toLowerCase()
  if (!scriptPath) return 'bash'
  const ext = scriptPath.split('.').pop()?.toLowerCase() ?? ''
  const extMap: Record<string, string> = {
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    py: 'python',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    rb: 'ruby',
    pl: 'perl',
    pm: 'perl',
  }
  return extMap[ext] ?? 'bash'
}

const SUPPORTED = new Set(['bash', 'sh', 'python', 'javascript', 'typescript', 'ruby', 'perl'])

// ─── CronScriptTab ───────────────────────────────────────────────────────────

export default function CronScriptTab(): React.ReactElement {
  const { selectedJobId, selectedJobDetail, jobs } = useCronStore()
  const job = jobs.find((j) => j.id === selectedJobId)
  const detail = selectedJobDetail?.id === selectedJobId ? selectedJobDetail : null

  const code = detail?.scriptContent ?? job?.command ?? ''
  const language = detectLanguage(
    detail?.scriptLanguage ?? null,
    detail?.scriptPath ?? job?.scriptPath ?? null
  )
  const resolvedLang = SUPPORTED.has(language) ? language : 'bash'
  const scriptPath = detail?.scriptPath ?? job?.scriptPath ?? null

  const highlighted = useMemo(() => {
    if (!code) return ''
    try {
      return hljs.highlight(code, { language: resolvedLang }).value
    } catch {
      return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  }, [code, resolvedLang])

  // Split into lines for line-number gutter
  const lines = highlighted.split('\n')
  // Remove trailing empty line that split often adds
  if (lines[lines.length - 1] === '') lines.pop()

  if (!job) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--fg-muted)] text-sm">
        No job selected
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Breadcrumb / toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] shrink-0 text-xs">
        {scriptPath ? (
          <span className="text-[var(--fg-muted)] font-mono truncate flex-1" title={scriptPath}>
            {scriptPath}
          </span>
        ) : (
          <span className="text-[var(--fg-muted)] truncate flex-1 italic">Inline command</span>
        )}
        <span className="shrink-0 px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--fg-muted)]">
          {resolvedLang}
        </span>
      </div>

      {/* Code viewer */}
      <div className="flex-1 overflow-auto bg-[#0d1117] text-xs font-mono leading-5">
        {code ? (
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="hover:bg-white/5">
                  <td
                    className="select-none text-right pr-4 pl-3 text-[var(--fg-muted)] border-r border-white/10 w-[3rem] shrink-0 sticky left-0 bg-[#0d1117]"
                    style={{ userSelect: 'none' }}
                  >
                    {i + 1}
                  </td>
                  <td className="pl-4 pr-4 whitespace-pre">
                    <span dangerouslySetInnerHTML={{ __html: line || ' ' }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-4 text-[var(--fg-muted)] italic">No script content available</div>
        )}
      </div>
    </div>
  )
}
