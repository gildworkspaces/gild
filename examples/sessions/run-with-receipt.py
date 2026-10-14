import datetime, json, pathlib, shlex, subprocess, sys, time, uuid
repo,pull,agent,model,*args=sys.argv[1:]; split=args.index('--'); reads=args[:split]; command=args[split+1:]
now=lambda: datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")
def files():
    paths=subprocess.check_output(['git','ls-files','-co','--exclude-standard','-z']).decode().split('\0')
    return {p:(pathlib.Path(p).stat().st_mtime_ns,pathlib.Path(p).stat().st_size) for p in paths if p and pathlib.Path(p).is_file() and not p.startswith('.gild-receipts/')}
before=files(); started=now(); tick=time.monotonic()
result=subprocess.run(command); duration=(time.monotonic()-tick)*1000; ended=now(); after=files()
written=sorted(p for p in set(before)|set(after) if before.get(p)!=after.get(p))
payload=dict(id=str(uuid.uuid4()),started_at=started,ended_at=ended,model=model,commands=[dict(name=shlex.join(command),exit_code=result.returncode,duration_ms=duration)],files=dict(read=reads,written=written),notes='Caller-declared reads; working-tree changes observed during command. Token usage/cost not measured.')
folder=pathlib.Path('.gild-receipts'); folder.mkdir(exist_ok=True)
output=folder/(payload['id']+'.json'); output.write_text(json.dumps(payload))
posted=subprocess.run(['gild','session','record','--repo',repo,'--pull',pull,'--agent',agent,'--file',str(output)])
if posted.returncode: print('Receipt retained for retry: '+str(output),file=sys.stderr)
sys.exit(result.returncode or posted.returncode)
