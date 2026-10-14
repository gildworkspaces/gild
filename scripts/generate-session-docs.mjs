import {readFileSync,writeFileSync} from 'node:fs'
const files=['claude-hook','run-with-receipt']
writeFileSync('lib/sessions/examples.ts','// Generated from the runnable Python examples by generate-session-docs.mjs.\nexport const examples='+JSON.stringify(Object.fromEntries(files.map(name=>[name,readFileSync('examples/sessions/'+name+'.py','utf8')])),null,2)+' as const\n')
