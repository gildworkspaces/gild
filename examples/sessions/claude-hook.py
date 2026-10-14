# Receipt collection runs on the agent machine.
import datetime, json, pathlib, sqlite3, subprocess, sys, time, uuid
h=json.load(sys.stdin); c=json.loads(pathlib.Path(sys.argv[1]).read_text()); now=lambda: datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")
root=pathlib.Path(h['cwd']); folder=root/'.gild-receipts'; folder.mkdir(exist_ok=True)
db=sqlite3.connect(folder/'hooks.sqlite'); db.execute('CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,body TEXT)')
db.execute('BEGIN IMMEDIATE'); old=db.execute('SELECT body FROM receipts WHERE id=?',(h['session_id'],)).fetchone()
d=json.loads(old[0]) if old else dict(id=str(uuid.uuid5(uuid.NAMESPACE_URL,h['session_id'])),started_at=now(),model=c['model'],commands=[],files=dict(read=[],written=[]),notes='Hook report; usage/cost and unavailable exit codes are not measured.',starts={})
e=h['hook_event_name']; tool=h.get('tool_name'); inp=h.get('tool_input',{}); key=h.get('tool_use_id',''); response=h.get('tool_response',{})
if e=='PreToolUse': d['starts'][key]=time.monotonic()
if e in ('PostToolUse','PostToolUseFailure') and tool=='Bash': d['commands'].append(dict(name=inp['command'],exit_code=response.get('exit_code') if isinstance(response,dict) else None,duration_ms=h.get('duration_ms',max(0,(time.monotonic()-d['starts'].pop(key,time.monotonic()))*1000))))
if e=='PostToolUse' and tool in ('Read','Write','Edit') and inp.get('file_path'):
    path=pathlib.Path(inp['file_path']).resolve(); kind='read' if tool=='Read' else 'written'
    if path.is_relative_to(root.resolve()): d['files'][kind]=sorted(set(d['files'][kind]+[str(path.relative_to(root.resolve()))]))
if e=='SessionEnd': d['ended_at']=now()
db.execute('INSERT OR REPLACE INTO receipts VALUES (?,?)',(h['session_id'],json.dumps(d)))
db.commit(); db.close()
if e=='SessionEnd':
    output=folder/(d['id']+'.json'); output.write_text(json.dumps({k:v for k,v in d.items() if k!='starts'}))
    result=subprocess.run(['gild','session','record','--repo',c['repo'],'--pull',str(c['pull']),'--agent',c['agent'],'--file',str(output)],stdout=subprocess.DEVNULL)
    sys.exit(result.returncode)
