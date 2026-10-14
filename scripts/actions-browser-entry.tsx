import { createRoot } from 'react-dom/client'
import { ActionsBoard, ActionRun } from '../components/repo/Actions'
import { RepoTabs } from '../components/repo/RepoTabs'
import '../app/globals.css'
const params = await (await fetch('/fixture-props')).json(),
  match = /\/actions\/(\d+)$/.exec(location.pathname)
const content = match ? (
  <ActionRun
    owner="acme"
    repo="demo"
    initial={await (
      await fetch(`/api/repos/acme/demo/actions/runs/${match[1]}`)
    ).json()}
    writer
  />
) : (
  <ActionsBoard
    owner="acme"
    repo="demo"
    initial={params.view}
    workflows={params.workflows.map((w: any) => ({
      ...w,
      dispatch: Boolean(w.triggers.workflow_dispatch),
    }))}
    branches={['main']}
    defaultBranch="main"
  />
)
createRoot(document.getElementById('app')!).render(
  <main
    style={{
      maxWidth: 1100,
      padding: '24px 20px',
      width: '100%',
      boxSizing: 'border-box',
      margin: '0 auto',
    }}
  >
    <h1 style={{ fontSize: 24 }}>acme / demo</h1>
    <RepoTabs
      base="/acme/demo"
      tabs={[
        { label: 'Code', path: '' },
        { label: 'Actions', path: '/actions' },
      ]}
    />
    {content}
  </main>,
)
