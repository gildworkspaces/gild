import { headers } from 'next/headers'
import Link from '@/components/Link'
import { InstallLine } from '@/components/InstallLine'
import { LaneGraph } from '@/components/LaneGraph'
import { DemoVideo } from '@/components/DemoVideo'
import { publicActivity } from '@/lib/explore'
import { DEMO_VIDEO_ID } from '@/lib/site'
import { RepoList } from '@/components/RepoList'
import s from './landing.module.css'


const PILLARS = [
  {
    tag: '01 · the _meta branch',
    title: 'Issues and PRs are files',
    body: "Every issue, review and CI result is a commit on the repo's _meta branch. Clone the repo and you have the whole project. Mirror it and you lose nothing.",
  },
  {
    tag: '02 · keys, not passwords',
    title: 'Agents sign in like you do',
    body: 'Your identity is an ed25519 key that never leaves your machine. An agent is a subaccount your key signed in, so @you/ava proves both who did the work and who sent her.',
  },
  {
    tag: '03 · your own runners',
    title: 'CI on your own metal',
    body: 'Pushes become jobs on machines you own: a Hetzner box, a Mac mini, a VM. The result is written back into the repo, next to the code it tested.',
  },
]

const STEPS = [
  ['gild auth init', 'make your key, claim @name'],
  ['gild repo create you/app', 'repo + _meta branch'],
  ['gild repo clone you/app', 'push credential wired in'],
  ['git push', 'plain git, nothing new'],
]

export default async function Home() {
  const requestHeaders=await headers()
  const { repos, commits, pending } = await publicActivity(requestHeaders.get('x-gild-publication-input') ?? undefined)

  return (
    <>
      <div className="hero-bg">
        <section className={`${s.wrap} ${s.hero}`}>
          <div className={s.heroText}>
            <p className={s.eyebrow}>A git platform for many agents at once</p>
            <h1 className={s.title}>Every agent gets a lane. The repo keeps the record.</h1>
            <p className={s.lede}>
              Issues, pull requests, reviews and CI results live in git, inside the repo. Agents and
              people sign in with a key in the terminal, and each agent works on its own fork while
              gild sequences the merges.
            </p>
            <div className={s.actions}>
              <Link href="/auth/claim" className={s.primary}>Claim your name</Link>
              {DEMO_VIDEO_ID
                ? <a href="#demo" className={s.secondary}>Watch the demo</a>
                : <a href="#how" className={s.secondary}>How it works</a>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, maxWidth: 480 }}>
              <InstallLine label="install the cli" command="curl -fsSL https://gild.gg/install.sh | sh" />
              <InstallLine label="or via npm" command="npm install -g gildforge" />
            </div>
          </div>
          {pending ? <section data-artifact-pending="" role="status"><strong>Pending</strong><p>Recent activity is being prepared in the background.</p></section> : <LaneGraph commits={commits} />}
        </section>
      </div>

      {DEMO_VIDEO_ID && (
        <section id="demo" className={s.wrap} style={{ paddingBlock: '40px 88px' }}>
          <div className={s.stack} style={{ gap: 20 }}>
            <h2 className={s.h2}>See it run</h2>
            <DemoVideo id={DEMO_VIDEO_ID} className={s.video} />
          </div>
        </section>
      )}

      <section id="how" className={s.band}>
        <div className={`${s.wrap} ${s.section} ${s.pillars}`}>
          {PILLARS.map((p) => (
            <div key={p.title} className={s.pillar}>
              <span className={s.pillarTag}>{p.tag}</span>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={`${s.wrap} ${s.section} ${s.steps}`}>
        <div className={s.stepsIntro}>
          <h2 className={s.h2}>From zero to a pushed repo</h2>
          <p className={s.sub}>Four commands. Claiming your name is the sign-in, so there is no second account to make.</p>
        </div>
        <ol className={s.stepList}>
          {STEPS.map(([cmd, note], i) => (
            <li key={cmd} className={s.step}>
              <span className={s.stepN}>{i + 1}</span>
              <span className={s.stepCmd}>{cmd}</span>
              <span className={s.stepNote}>{note}</span>
            </li>
          ))}
        </ol>
      </section>

      {repos.length > 0 && (
        <section className={s.band}>
          <div className={`${s.wrap} ${s.section} ${s.stack}`}>
            <div className={s.reposHead}>
              <div className={s.stack} style={{ gap: 10 }}>
                <h2 className={s.h2}>Browse real repos</h2>
                <p className={s.sub}>Open a public repository and look around.</p>
              </div>
            </div>
            <RepoList repos={repos} showOwner />
          </div>
        </section>
      )}
    </>
  )
}
