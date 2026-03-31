/**
 * minion-notify.ts — Multi-channel notification for nightly reports.
 * Channels: agentboard (in-app WS), Telegram bot, email (SMTP).
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NightlyReport {
  date: string
  project: string
  startedAt: string
  completedAt: string
  durationMinutes: number
  detect: {
    detectors_run: string[]
    findings_total: number
    tickets_created: number
    tickets_stale_resolved: number
  }
  fix: {
    cycles: number
    fixed: number
    failed: number
    skipped_blocked: number
    small: { dispatched: number; succeeded: number; failed: number }
    medium: { dispatched: number; succeeded: number; failed: number }
    prs_opened: string[]
  }
  backlog: {
    total_open: number
    by_effort: Record<string, number>
    by_category: Record<string, number>
    blocked: number
  }
  notable_failures: Array<{ ticket_id: string; title: string; reason: string }>
}

export interface NotificationConfig {
  telegram?: {
    enabled: boolean
    bot_token: string
    chat_id: string
  }
  email?: {
    enabled: boolean
    smtp_host: string
    smtp_port: number
    from: string
    to: string
    username: string
    password: string
  }
}

// ─── Channel Interface ───────────────────────────────────────────────────────

interface NotifyChannel {
  name: string
  send(report: NightlyReport): Promise<void>
}

// ─── Format Helpers ──────────────────────────────────────────────────────────

function formatReportText(report: NightlyReport): string {
  const lines: string[] = []
  lines.push(`Nightly Run — ${report.date}`)
  lines.push(`Duration: ${report.durationMinutes}m | Cycles: ${report.fix.cycles}`)
  lines.push('')

  // Detection
  if (report.detect.findings_total > 0 || report.detect.tickets_created > 0) {
    lines.push(`Detect: ${report.detect.findings_total} findings, ${report.detect.tickets_created} new tickets, ${report.detect.tickets_stale_resolved} stale resolved`)
  }

  // Fix results
  lines.push(`Fixed: ${report.fix.fixed} (${report.fix.small.succeeded}s ${report.fix.medium.succeeded}m)`)
  lines.push(`Failed: ${report.fix.failed} (${report.fix.small.failed}s ${report.fix.medium.failed}m)`)
  if (report.fix.skipped_blocked > 0) {
    lines.push(`Blocked: ${report.fix.skipped_blocked} stuck tickets skipped`)
  }
  lines.push('')

  // Backlog
  lines.push(`Backlog: ${report.backlog.total_open} open, ${report.backlog.blocked} blocked`)
  const efforts = Object.entries(report.backlog.by_effort).map(([k, v]) => `${v}${k[0]}`).join(' ')
  if (efforts) lines.push(`  Effort: ${efforts}`)
  lines.push('')

  // PRs
  if (report.fix.prs_opened.length > 0) {
    lines.push('PRs:')
    for (const pr of report.fix.prs_opened) lines.push(`  ${pr}`)
    lines.push('')
  }

  // Notable failures
  if (report.notable_failures.length > 0) {
    lines.push('Top failures:')
    for (const f of report.notable_failures.slice(0, 5)) {
      lines.push(`  • ${f.ticket_id}: ${f.title.slice(0, 60)}`)
    }
  }

  return lines.join('\n')
}

function escapeTelegramMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\function formatTelegramMessage(report: NightlyReport): string {')
}

function formatTelegramMessage(report: NightlyReport): string {
  // Use emojis for Telegram readability
  const lines: string[] = []
  lines.push(`🌙 *Nightly Run — ${report.date}*`)
  lines.push('')
  lines.push(`✅ Fixed: ${report.fix.fixed} (${report.fix.small.succeeded} small, ${report.fix.medium.succeeded} medium)`)
  lines.push(`❌ Failed: ${report.fix.failed}`)
  if (report.fix.skipped_blocked > 0) lines.push(`🚫 Blocked: ${report.fix.skipped_blocked} stuck`)
  lines.push(`📋 Backlog: ${report.backlog.total_open} open, ${report.backlog.blocked} blocked`)
  lines.push('')

  if (report.fix.prs_opened.length > 0) {
    lines.push(`🔗 PRs: ${report.fix.prs_opened.join(', ')}`)
    lines.push('')
  }

  if (report.notable_failures.length > 0) {
    lines.push('*Top failures:*')
    for (const f of report.notable_failures.slice(0, 5)) {
      lines.push(`• ${f.ticket_id}: ${escapeTelegramMarkdown(f.title.slice(0, 50))}`)
    }
  }

  return lines.join('\n')
}

// ─── Channel Implementations ─────────────────────────────────────────────────

class AgentboardChannel implements NotifyChannel {
  name = 'agentboard'
  constructor(private apiUrl: string) {}

  async send(report: NightlyReport): Promise<void> {
    const resp = await fetch(`${this.apiUrl}/api/nightly/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    })
    if (!resp.ok) {
      console.log(`[notify][agentboard] POST failed: ${resp.status}`)
    }
  }
}

class TelegramChannel implements NotifyChannel {
  name = 'telegram'
  constructor(private botToken: string, private chatId: string) {}

  async send(report: NightlyReport): Promise<void> {
    const text = formatTelegramMessage(report)
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }),
    })
    if (!resp.ok) {
      const body = await resp.text()
      console.log(`[notify][telegram] Failed: ${resp.status} ${body.slice(0, 200)}`)
    }
  }
}

class EmailChannel implements NotifyChannel {
  name = 'email'
  constructor(private config: NonNullable<NotificationConfig['email']>) {}

  async send(report: NightlyReport): Promise<void> {
    const subject = `Nightly Run ${report.date}: ${report.fix.fixed} fixed, ${report.fix.failed} failed`
    const body = formatReportText(report)
    const password = process.env.SMTP_PASSWORD || this.config.password
    const tmpFile = `/tmp/msmtp-pass-${process.pid}`

    try {
      fs.writeFileSync(tmpFile, password, { mode: 0o600 })
      const result = Bun.spawnSync(
        ['msmtp', '--host', this.config.smtp_host, '--port', String(this.config.smtp_port),
         '--from', this.config.from, '--auth=on',
         '--user', this.config.username || process.env.SMTP_USERNAME || '',
         '--passwordfile', tmpFile,
         '--tls=on', this.config.to],
        {
          stdin: new TextEncoder().encode(
            `From: ${this.config.from}\r\nTo: ${this.config.to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
          ),
        }
      )
      if (result.exitCode !== 0) {
        console.log(`[notify][email] msmtp failed (exit ${result.exitCode}), email not sent`)
      }
    } finally {
      try { fs.unlinkSync(tmpFile) } catch { /* best effort */ }
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function loadNotificationConfig(): NotificationConfig {
  const configPath = path.join(process.env.HOME ?? '/root', '.agentboard', 'minion-projects.yaml')
  try {
    if (fs.existsSync(configPath)) {
      const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
      return (raw as { notifications?: NotificationConfig }).notifications ?? {}
    }
  } catch { /* ignore */ }
  return {}
}

export function buildChannels(apiUrl: string, config: NotificationConfig): NotifyChannel[] {
  const channels: NotifyChannel[] = []

  // Agentboard is always enabled
  channels.push(new AgentboardChannel(apiUrl))

  // Telegram
  if (config.telegram?.enabled && config.telegram.bot_token && config.telegram.chat_id) {
    const token = process.env.TELEGRAM_BOT_TOKEN || config.telegram.bot_token
    channels.push(new TelegramChannel(token, config.telegram.chat_id))
  }

  // Email
  if (config.email?.enabled && config.email.smtp_host && config.email.to) {
    channels.push(new EmailChannel(config.email))
  }

  return channels
}

export async function sendNotifications(report: NightlyReport, channels: NotifyChannel[]): Promise<void> {
  for (const channel of channels) {
    try {
      await channel.send(report)
      console.log(`[notify][${channel.name}] Sent successfully`)
    } catch (err) {
      console.log(`[notify][${channel.name}] Error: ${err}`)
    }
  }
}

// Also export the text formatter for other uses (e.g., CLI summary)
export { formatReportText }
