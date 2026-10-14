import {routes} from '../lib/api/contract'
console.log('| Method | Path (under /api/v1) | Scope | GitHub compatible | Cache policy |\n|---|---|---|---|---|')
for(const r of routes.filter(r=>!process.argv[2]||r.phase===process.argv[2]))console.log(`| ${r.method} | \`${r.path}\` | ${r.scope ?? 'public'} | ${r.github ? 'yes' : 'no'} | ${r.cache} |`)
