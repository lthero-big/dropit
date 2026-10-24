import { useState, type ReactNode } from 'react'

const markdownHint = /(^#{1,6}\s)|(^\s*[-*]\s)|(```)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\(https?:\/\/[^)]+\))|(^\d+\.\s)|(^>\s)/m

function looksLikeMarkdown(text: string) {
  return markdownHint.test(text)
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

function inlineNodes(source: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`\n]+`)|(\*\*[^*]+?\*\*)|(\*[^*\n]+?\*)|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g
  let last = 0
  let index = 0
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last) nodes.push(source.slice(last, start))
    const token = match[0]
    const key = `${keyPrefix}-${index++}`
    if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('*')) nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token)
      const href = link ? safeHttpUrl(link[2]) : null
      if (link && href) {
        nodes.push(
          <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {link[1]}
          </a>,
        )
      } else nodes.push(token)
    }
    last = start + token.length
  }
  if (last < source.length) nodes.push(source.slice(last))
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
  return <div className="text-[15px] break-words">{blocks}</div>
}

export function MarkdownText({ text }: { text: string }) {
  const markdown = looksLikeMarkdown(text)
  const [rendered, setRendered] = useState(false)
  return (
    <div>
      {markdown ? (
        <div className="mb-2 flex gap-1" role="group" aria-label="文本视图">
          <button
            type="button"
            aria-pressed={!rendered}
            className={`border px-2 py-0.5 text-xs font-extrabold ${rendered ? 'border-foreground' : 'border-primary bg-primary text-primary-foreground'}`}
            onClick={() => setRendered(false)}
          >
            源码
          </button>
          <button
            type="button"
            aria-pressed={rendered}
            className={`border px-2 py-0.5 text-xs font-extrabold ${rendered ? 'border-primary bg-primary text-primary-foreground' : 'border-foreground'}`}
            onClick={() => setRendered(true)}
          >
            渲染
          </button>
        </div>
      ) : null}
      {rendered && markdown ? <MarkdownBody source={text} /> : <p className="text-[15px] break-words whitespace-pre-wrap">{text}</p>}
    </div>
  )
}
