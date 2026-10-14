import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
export async function verifySessionExamples({
  request,
  runCLI,
  cli,
  identityDir,
  work,
  fixture,
  origin,
  agentToken,
  now,
  sessionInput,
  sessionBase,
  auth,
}) {
  mkdirSync(join(identityDir, 'agents'), { mode: 0o700 })
  writeFileSync(
    join(identityDir, 'agents', 'requested.json'),
    JSON.stringify({
      schema: 1,
      name: 'acme/requested',
      server: origin,
      publicKey: 'ed25519:fixture',
      secretKey: 'generated-unused-fixture',
      requestId: 'fixture',
      token: agentToken,
      createdAt: now,
    }),
    { mode: 0o600 },
  )
  const reportFile = join(work, 'report.json')
  writeFileSync(
    reportFile,
    JSON.stringify({
      ...sessionInput,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    }),
  )
  const cliReceipt = JSON.parse(
    await runCLI(
      'session',
      'record',
      '--repo',
      'acme/demo',
      '--pull',
      '2',
      '--agent',
      'requested',
      '--file',
      reportFile,
    ),
  )
  assert.equal(cliReceipt.closed, true)
  assert.equal(
    JSON.parse(
      await runCLI(
        'session',
        'record',
        '--repo',
        'acme/demo',
        '--pull',
        '2',
        '--agent',
        'requested',
        '--file',
        reportFile,
      ),
    ).id,
    cliReceipt.id,
    'CLI retries one report idempotently',
  )
  assert.ok(
    JSON.parse(
      await runCLI('session', 'list', '--repo', 'acme/demo', '--pull', '2'),
    ).some((r) => r.id === cliReceipt.id),
  )
  const bin = join(work, 'bin')
  mkdirSync(bin)
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'"
  writeFileSync(
    join(bin, 'gild'),
    '#!/bin/sh\nexec ' +
      quote(join(cli, 'dist', 'gild')) +
      ' --config-dir ' +
      quote(identityDir) +
      ' "$@" --server ' +
      quote(origin) +
      '\n',
  )
  chmodSync(join(bin, 'gild'), 0o700)
  const exampleEnv = { ...process.env, PATH: bin + ':' + process.env.PATH },
    hookConfig = join(work, 'hook-config.json')
  writeFileSync(
    hookConfig,
    JSON.stringify({
      repo: 'acme/demo',
      pull: 2,
      agent: 'requested',
      model: 'hook-model',
    }),
  )
  const hookId = randomBytes(16).toString('hex'),
    hookScript = resolve('examples/sessions/claude-hook.py')
  const hook = async (data) => {
    const child = spawn('python3', [hookScript, hookConfig], {
      cwd: fixture,
      env: exampleEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let errors = ''
    child.stderr.on('data', (b) => (errors += b))
    child.stdin.end(
      JSON.stringify({ cwd: fixture, session_id: hookId, ...data }),
    )
    assert.equal(await new Promise((r) => child.once('exit', r)), 0, errors)
  }
  await hook({ hook_event_name: 'SessionStart' })
  await hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'one',
  })
  await hook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'one',
    tool_input: { command: 'echo fixture' },
    tool_response: { exit_code: 0 },
  })
  await hook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: join(fixture, 'README.md') },
  })
  await hook({ hook_event_name: 'SessionEnd' })
  let reports = await (await request(sessionBase)).json()
  const hookReport = reports.find((r) => r.model === 'hook-model')
  assert.ok(hookReport.closed)
  assert.equal(hookReport.commands[0].exit_code, 0)
  assert.deepEqual(hookReport.files.read, ['README.md'])
  try {
    await promisify(execFile)(
      'python3',
      [
        resolve('examples/sessions/run-with-receipt.py'),
        'acme/demo',
        '2',
        'requested',
        'wrapper-model',
        'README.md',
        '--',
        'python3',
        '-c',
        'from pathlib import Path; Path("README.md").write_text("wrapper changed"); raise SystemExit(7)',
      ],
      { cwd: fixture, env: exampleEnv, encoding: 'utf8' },
    )
    assert.fail('Command must retain exit 7')
  } catch (e) {
    assert.equal(e.code, 7, e.stderr)
  }
  reports = await (await request(sessionBase)).json()
  const wrapperReport = reports.find((r) => r.model === 'wrapper-model')
  assert.ok(wrapperReport)
  assert.equal(wrapperReport.commands[0].exit_code, 7)
  assert.ok(wrapperReport.files.written.includes('README.md'))
  const paged = await request(sessionBase + '?per_page=1')
  assert.equal((await paged.json()).length, 1)
  assert.ok(paged.headers.get('link'))
  const next = paged.headers.get('link').match(/<([^>]+)>; rel="next"/)[1]
  assert.equal((await (await fetch(next, { headers: auth })).json()).length, 1)
  console.log(
    'Session CLI: authenticated report record/list and idempotent retry; 20-line Claude hook + generic wrapper used compiled gild and preserved failed command exit',
  )
}
