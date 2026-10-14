// Rebuild real production artifacts with one behavior removed at a time.
// Originals are restored even when an assertion/build fails.
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { presentationCSS } from './render-build.mjs'
mkdirSync('.tmp', {recursive:true})
function run(name,args) {
  const result=spawnSync(args[0],args.slice(1),{encoding:'utf8',timeout:600000,maxBuffer:16*1024*1024})
  writeFileSync(`.tmp/repo-shell-revert-${name}.log`,result.stdout+result.stderr)
  return result
}
const build=()=>assert.equal(run('build',['bun','run','build:cloudflare']).status,0,'production build must pass')
const fails=(name,args,pattern)=>{
  const result=run(name,[process.execPath,'scripts/repo-shell-browser.mjs',...args])
  assert.notEqual(result.status,0,`${name} must fail with its behavior removed`)
  assert.match(result.stdout+result.stderr,/AssertionError/)
  assert.match(result.stdout+result.stderr,pattern)
  console.log(`PASS revert ${name}: browser effect assertion fails`)
}
const headerFiles=['packages/render/Shell.tsx','components/SiteHeader.tsx','components/repo/RepoTabs.tsx','components/repo/StarButton.tsx','components/repo/CloneButton.tsx','app/(portal)/[owner]/[repo]/layout.tsx','app/(portal)/[owner]/[repo]/repo.module.css','app/globals.css','packages/render/router.ts']
const originals=new Map(headerFiles.map(p=>[p,readFileSync(p,'utf8')]))
try {
  for(const p of headerFiles){let text=execFileSync('git',['show',`0fe4aef:${p}`],{encoding:'utf8'});if(p==='packages/render/Shell.tsx')text="import { fontCSS } from '../presentation/fonts'\n"+text.replace('Shell({ css, version }: { css: string; version: string })', 'Shell({ css = '+JSON.stringify(presentationCSS())+', version }: { css?: string; version: string })').replace('__html: css','__html: fontCSS(version) + css');writeFileSync(p,text)}
  build()
  assert.equal(run('screenshots',[process.execPath,'scripts/repo-shell-browser.mjs','--before']).status,0,'baseline screenshots')
  fails('headers',['--headers-only'],/cold Code has .portal-bar|shared chrome: direct/)
} finally {
  for(const [p,text]of originals)writeFileSync(p,text)
  build()
}
if(process.argv.includes('--headers-only')) process.exit(0)
const path='packages/render/scroll.ts', original=readFileSync(path,'utf8')
function render(name) {
  assert.equal(run(name,['bun','run','build:render']).status,0)
  // Workers static assets precede the Worker route: replace the browser copy
  // as well as the independent renderer so the actual page executes the revert.
  cpSync('public/gild-fragments','.open-next/assets/gild-fragments',{recursive:true})
}
const cases=[
  ['push',"else window.scrollTo(0, 0)","else {}",/push file scrolls to top/],
  ['history',"window.scrollTo(0, history.state?.gildScrollY ?? 0)","window.scrollTo(0, 0)",/back restores file entry/],
  ['hash',"if (target) target.scrollIntoView()","if (target) window.scrollTo(0, 0)",/push follows hash target/],
  ['boot',"export function installScroll() {","export function installScroll() { window.scrollTo(0, 0)",/late boot preserves reader position/],
  ['tip',"if (mode === 'preserve') window.scrollTo(0, previousY)","if (mode === 'preserve') window.scrollTo(0, 0)",/tip refresh preserves reader position/],
]
try {
  for(const [name,before,after,pattern]of cases) {
    assert.ok(original.includes(before))
    writeFileSync(path,original.replace(before,after))
    render('render-'+name)
    fails(name,['--scroll-only'],pattern)
  }
} finally {
  writeFileSync(path,original)
  render('render-restored')
}
assert.equal(run('restored',[process.execPath,'scripts/repo-shell-browser.mjs']).status,0,'restored production browser suite')
console.log('PASS restored direct/in-site chrome, CLS, push/history/hash/boot/tip browser suite')
