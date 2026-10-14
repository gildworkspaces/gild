import { createRoot } from 'react-dom/client'
import { SessionReceipts } from '../components/repo/SessionReceipts'
import { Glance } from '../components/repo/Glance'
import '../app/globals.css'
const receipts = await (await fetch('/receipts')).json(),
  files = [
    {
      path: 'src/main.ts',
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      hunks: [],
      binary: false,
    },
  ],
  sizes = [
    { path: 'README.md', lines: 1 },
    { path: 'src/main.ts', lines: 1 },
  ]
createRoot(document.getElementById('app')!).render(
  <>
    <Glance
      receipts={receipts}
      files={files}
      sizes={sizes}
      root=""
      what="pull request"
      fileHref={(p) => '#file-' + p}
      zoomHref={(p) => '#dir-' + p}
    />
    <SessionReceipts receipts={receipts} fileHref={(p) => '#file-' + p} />
  </>,
)
