import { useState, type ReactNode } from 'react'

const markdownHint = /(^#{1,6}\s)|(^\s*[-*]\s)|(```)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\(https?:\/\/[^)]+\))|(^\d+\.\s)|(^>\s)/m
const autolinkPattern = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%[\]]+/gi
const trailingPunctuation = new Set(['.', ',', '!', '?', "'", ';', ':'])
const linkClass = 'text-primary underline underline-offset-2 [overflow-wrap:anywhere]'

function looksLikeMarkdown(text: string) {
  return markdownHint.test(text)
}

function balance(value: string, open: string, close: string) {
  let count = 0
  for (const char of value) {
    if (char === open) count += 1
    else if (char === close) count -= 1
  }
  return count
}

function trimTrailing(value: string) {
  let end = value.length
  while (end > 0) {
    const char = value[end - 1]
    if (char === ')' && balance(value.slice(0, end), '(', ')') < 0) {
      end -= 1
      continue
    }
    if (char === ']' && balance(value.slice(0, end), '[', ']') < 0) {
      end -= 1
      continue
    }
    if (trailingPunctuation.has(char)) {
      end -= 1
      continue
    }
    break
  }
  return value.slice(0, end)
}

function safeHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

// The href is the trimmed source text, so the visible label and the attribute match.
// Hosts the parser rewrites (userinfo, decimal or hex IPs) stay plain text.
function autolinkHref(raw: string): string | null {
  const href = trimTrailing(raw)
  if (!href) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  if (!/[0-9a-z]/.test(host)) return null
  if (!href.toLowerCase().includes(host)) return null
  return href
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className={linkClass}>
      {children}
    </a>
  )
}

function linkifyNodes(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(autolinkPattern)) {
    const start = match.index ?? 0
    const href = autolinkHref(match[0])
    if (!href) continue
    if (start > last) nodes.push(text.slice(last, start))
    nodes.push(
      <ExternalLink key={`${keyPrefix}-${index}`} href={href}>
        {href}
      </ExternalLink>,
    )
    index += 1
    last = start + href.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  if (nodes.length === 0) nodes.push(text)
  return nodes
}

function inlineNodes(source: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`\n]+`)|(\*\*[^*]+?\*\*)|(\*[^*\n]+?\*)|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g
  let last = 0
  let index = 0
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last) nodes.push(...linkifyNodes(source.slice(last, start), `${keyPrefix}-t${index}`))
    const token = match[0]
    const key = `${keyPrefix}-${index}`
    index += 1
    if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**')) nodes.push(<strong key={key}>{linkifyNodes(token.slice(2, -2), key)}</strong>)
    else if (token.startsWith('*')) nodes.push(<em key={key}>{linkifyNodes(token.slice(1, -1), key)}</em>)
    else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token)
      const href = link ? safeHttpUrl(link[2]) : null
      if (link && href) nodes.push(<ExternalLink key={key} href={href}>{link[1]}</ExternalLink>)
      else nodes.push(...linkifyNodes(token, key))
    }
    last = start + token.length
  }
  if (last < source.length) nodes.push(...linkifyNodes(source.slice(last), `${keyPrefix}-end`))
  return nodes
}

function MarkdownBody({ source }: { source: string }) {
  const lines = source.split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  let key = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.startsWith('```')) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index].startsWith('```')) {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push(
        <pre key={key} className="my-2 overflow-auto border border-foreground p-2">
          <code>{code.join('\n')}</code>
        </pre>,
      )
      key += 1
      continue
    }
    const heading = /^(#{1,3})\s+(.*)/.exec(line)
    if (heading) {
      const Tag = (`h${heading[1].length + 2}` as 'h3' | 'h4' | 'h5')
      blocks.push(
        <Tag key={key} className="mt-2 font-extrabold">
          {inlineNodes(heading[2], `h-${key}`)}
        </Tag>,
      )
      key += 1
      index += 1
      continue
    }
    if (/^---+$/.test(line)) {
      blocks.push(<hr key={key} className="my-3 border-foreground" />)
      key += 1
      index += 1
      continue
    }
    const quote = /^>\s?(.*)/.exec(line)
    if (quote) {
      blocks.push(
        <blockquote key={key} className="my-2 border-l-4 border-primary pl-3">
          {inlineNodes(quote[1], `q-${key}`)}
        </blockquote>,
      )
      key += 1
      index += 1
      continue
    }
    const listKind = /^\s*\d+\.\s+/.test(line) ? 'ol' : /^\s*[-*]\s+/.test(line) ? 'ul' : null
    if (listKind) {
      const items: ReactNode[] = []
      while (index < lines.length) {
        const current = lines[index]
        if (listKind === 'ol') {
          const ordered = /^\s*\d+\.\s+(.*)/.exec(current)
          if (!ordered) break
          items.push(<li key={index}>{inlineNodes(ordered[1], `ol-${index}`)}</li>)
        } else {
          const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)/.exec(current)
          const bullet = /^\s*[-*]\s+(.*)/.exec(current)
          if (task) {
            items.push(
              <li key={index}>
                <input type="checkbox" disabled checked={task[1].toLowerCase() === 'x'} /> {inlineNodes(task[2], `task-${index}`)}
              </li>,
            )
          } else if (bullet) items.push(<li key={index}>{inlineNodes(bullet[1], `ul-${index}`)}</li>)
          else break
        }
        index += 1
      }
      const List = listKind
      blocks.push(
        <List key={key} className={`my-2 pl-5 ${listKind === 'ol' ? 'list-decimal' : 'list-disc'}`}>
          {items}
        </List>,
      )
      key += 1
      continue
    }
    if (line.trim() === '') {
      index += 1
      continue
    }
    blocks.push(
      <p key={key} className="my-2">
        {inlineNodes(line, `p-${key}`)}
      </p>,
    )
    key += 1
    index += 1
  }
  return <div className="max-w-full min-w-0 text-[15px] [overflow-wrap:anywhere]">{blocks}</div>
}

export function MarkdownText({ text, collapsed = false }: { text: string; collapsed?: boolean }) {
  const markdown = looksLikeMarkdown(text)
  const [rendered, setRendered] = useState(false)
  return (
    <div className="max-w-full">
      {markdown ? (
        <div className="mb-2 inline-flex gap-0.5 rounded-md border border-border/70 bg-muted/40 p-0.5" role="group" aria-label="文本视图">
          <button
            type="button"
            aria-pressed={!rendered}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${rendered ? 'text-muted-foreground hover:text-foreground' : 'bg-background text-foreground shadow-sm'}`}
            onClick={() => setRendered(false)}
          >
            源码
          </button>
          <button
            type="button"
            aria-pressed={rendered}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${rendered ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setRendered(true)}
          >
            渲染
          </button>
        </div>
      ) : null}
      {rendered && markdown ? (
        <MarkdownBody source={text} />
      ) : (
        <p className={`max-w-full min-w-0 text-[15px] whitespace-pre-wrap [overflow-wrap:anywhere] ${collapsed ? 'line-clamp-6' : ''}`}>{linkifyNodes(text, 'plain')}</p>
      )}
    </div>
  )
}
