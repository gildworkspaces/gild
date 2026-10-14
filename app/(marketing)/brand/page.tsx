import s from './brand.module.css'

export const metadata = { title: 'Brand · gild' }

const MARK = '#f38020', BONE = '#efece4', INK = '#0b0a08'

const palettes = [
  { name: 'Dark', note: 'the default theme', light: false, colours: [
    ['bg', '#0b0c0e', 'page'], ['surface', '#14161a', 'cards, a step above the page'],
    ['panel', '#111316', 'code, inputs, menus'], ['ink', '#eceae4', 'text, the wordmark'],
    ['soft', '#b9b6ae', 'secondary text'], ['accent', '#e2b54a', 'links, primary action'],
    ['rule', '#23252a', 'rules, borders'], ['ok', '#7fc77a', 'additions, passing'],
    ['bad', '#e5736a', 'deletions, failing'],
  ] },
  { name: 'Light', note: 'light theme', light: true, colours: [
    ['bg', '#fafaf8', 'page'], ['surface', '#ffffff', 'cards, lighter than the page'],
    ['panel', '#f3f2ee', 'code, inputs, menus'], ['ink', '#17181b', 'text, the wordmark'],
    ['soft', '#4a4d55', 'secondary text'], ['accent', '#9a6b0c', 'links, primary action'],
    ['rule', '#dedbd4', 'rules, borders'], ['ok', '#2e8a3a', 'additions, passing'],
    ['bad', '#c2463b', 'deletions, failing'],
  ] },
] as const

const markColours = [
  [MARK, 'mark', 'the head, the antenna, Glance heat'],
  [BONE, 'visor', 'the face plate'],
  [INK, 'eyes', 'the eyes'],
] as const

const files = [
  ['mark', 'gild-mark.svg', 'SVG'],
  ['mark · small sizes', 'gild-mark-small.svg', 'SVG'],
  ['mark · transparent', 'gild-logo-transparent-1024.png', 'PNG 1024'],
  ['avatar · dark', 'github-org-avatar-500.png', 'PNG 500'],
  ['avatar · light', 'github-org-avatar-light-500.png', 'PNG 500'],
  ['avatar · orange', 'avatar-orange-512.png', 'PNG 512'],
  ['Discord server icon', 'discord-server-icon-512.png', 'PNG 512'],
  ['X avatar', 'x-avatar-400.png', 'PNG 400'],
  ['GitHub social preview', 'github-social-preview-1280x640.png', 'PNG 1280×640'],
  ['X header', 'x-header-1500x500.png', 'PNG 1500×500'],
  ['Discord banner', 'discord-banner-960x540.png', 'PNG 960×540'],
  ['link card · light', 'og-light-1200x630.png', 'PNG 1200×630'],
] as const

function Marks({ light }: { light: boolean }) {
  return (
    <div className={s.markCard} style={{ background: light ? '#fafaf8' : INK, color: light ? '#17181b' : BONE }}>
      <span className={s.cardLabel}>{light ? 'Light' : 'Dark'}</span>
      <div className={s.lockup}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static SVG mark */}
        <img src="/brand/gild-mark.svg" alt="" height={72} />
        <span className={s.wordmark}>gild</span>
      </div>
      <div className={s.sizes}>
        {[64, 32, 24, 16].map(px => (
          <figure key={px}>
            {/* eslint-disable-next-line @next/next/no-img-element -- static SVG mark */}
            <img src={px > 24 ? '/brand/gild-mark.svg' : '/brand/gild-mark-small.svg'} alt="" height={px} />
            <figcaption>{px}px</figcaption>
          </figure>
        ))}
      </div>
    </div>
  )
}

export default function Brand() {
  return (
    <article className={s.page}>
      <h1>Brand</h1>
      <p className={s.lead}>The wordmark, the robot, two palettes and two typefaces. Free to use when you write or talk about gild.</p>

      <h2>Wordmark and mark <small>a robot whose antenna is a branch</small></h2>
      <div className={s.pair}><Marks light={false} /><Marks light /></div>
      <div className={s.markColours}>
        {markColours.map(([hex, name, use]) => (
          <div key={name} className={s.swatch}><i style={{ background: hex }} /><span><b>{name}</b><code>{hex}</code><em>{use}</em></span></div>
        ))}
      </div>

      <h2>Palettes <small>dark is the default, light follows it</small></h2>
      <div className={s.pair}>
        {palettes.map(p => (
          <div key={p.name} className={s.palette} data-light={p.light || undefined}>
            <h3>{p.name} <small>{p.note}</small></h3>
            <div className={s.swatches}>
              {p.colours.map(([name, hex, use]) => (
                <div key={name} className={s.swatch}><i style={{ background: hex }} /><span><b>{name}</b><code>{hex}</code><em>{use}</em></span></div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <h2>Type <small>both self-hosted, both OFL</small></h2>
      <div className={s.type}>
        <p className={s.display}>A git platform for the agentic era</p>
        <p className={s.meta}><b>Schibsted Grotesk</b> · display, headings, copy and the wordmark · 400 · 600 · 800</p>
      </div>
      <div className={s.type}>
        <p className={s.mono}>gild repo clone avatest/plant-store</p>
        <p className={s.meta}><b>JetBrains Mono</b> · code, commands, hashes and labels · 400 · 500</p>
      </div>

      <h2>Using it <small>six rules</small></h2>
      <ol className={s.rules}>
        <li>The antenna is a git branch: one stem, two commits. The head and antenna are orange, the visor is bone, the eyes are ink. Keep those three colours.</li>
        <li>Orange <code>#f38020</code> is for the mark and Glance heat. Gold is the interface accent. They are never swapped.</li>
        <li>At 24px and below, use the small-size mark. Its antenna and ears are thicker so they survive a favicon.</li>
        <li>The wordmark is always lowercase: gild. Schibsted Grotesk 800, tight tracking.</li>
        <li>Put the mark on a palette background, never on a photo or a colour outside the palette.</li>
        <li>The robot sits beside the wordmark, never inside it, and is never taller than the wordmark&apos;s cap height plus the antenna.</li>
      </ol>

      <h2>Files <small>marks, avatars and banners</small></h2>
      <div className={s.files}>
        {files.map(([label, file, kind]) => (
          <a key={file} href={'/brand/' + file} download><span>{label}</span><small>{kind}</small></a>
        ))}
      </div>
    </article>
  )
}
