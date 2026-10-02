#!/usr/bin/env python3
"""Record one published-CLI demonstration, or replay its asciinema v2 capture."""
import argparse
import codecs
from datetime import datetime, timezone
import errno
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import time

ACTION = """const fs = require('node:fs');
const input = fs.readFileSync('ignored-input.txt', 'utf8');
if (input !== 'demo-only\\n') throw new Error('unexpected ignored input');
console.log('Ignored input in copy: ' + JSON.stringify(input));
fs.writeFileSync('message.txt', 'after\\n');
console.log('Copy edit: message.txt = ' + JSON.stringify(fs.readFileSync('message.txt', 'utf8')));
const stat = fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');
fs.writeFileSync(process.env.TWIN_DEMO_MARKER, JSON.stringify({pid: process.pid, group: Number(stat[2]), start: stat[19], cwd: process.cwd()}));
"""
COMMAND = 'twin run --receipt=text --review -- node demo.cjs'


def absent(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def replay(path, static):
    lines = path.read_text().splitlines()
    header = json.loads(lines[0])
    if header['version'] != 2:
        raise ValueError('expected asciinema v2')
    previous = 0
    for line in lines[1:]:
        elapsed, kind, value = json.loads(line)
        if not static:
            time.sleep(max(0, elapsed - previous))
        if kind == 'o':
            print(value, end='', flush=True)
        previous = elapsed


def record(destination):
    if destination.exists():
        raise FileExistsError('destination must not exist')
    destination.mkdir(parents=True)
    root = Path(tempfile.mkdtemp(prefix='twin-published-demo-'))
    home, prefix, project, scratch = [root / name for name in ('home', 'prefix', 'project', 'scratch')]
    for directory in (home, prefix, project, scratch, root / 'cache'):
        directory.mkdir()
    (root / 'npmrc').write_text('')
    (root / 'global-npmrc').write_text('')
    node = shutil.which('node')
    npm = shutil.which('npm')
    if not node or not npm:
        raise RuntimeError('Node and npm are required')
    env = {'PATH': str(Path(node).parent) + ':/usr/bin:/bin', 'HOME': str(home),
           'TMPDIR': str(scratch), 'NPM_CONFIG_PREFIX': str(prefix),
           'NPM_CONFIG_CACHE': str(root / 'cache'), 'NPM_CONFIG_USERCONFIG': str(root / 'npmrc'),
           'NPM_CONFIG_GLOBALCONFIG': str(root / 'global-npmrc'), 'GIT_CONFIG_NOSYSTEM': '1',
           'LANG': 'C.UTF-8', 'TERM': 'dumb', 'TWIN_DEMO_MARKER': str(root / 'action.json')}
    install = [npm, 'install', '--global', '--prefix', str(prefix), '--registry=https://registry.npmjs.org',
               '--ignore-scripts', '--no-audit', '--no-fund', '@twin-cli/cli@0.1.0']
    installed = subprocess.run(install, env=env, capture_output=True, text=True, timeout=120)
    (root / 'install.json').write_text(json.dumps({'argv': install, 'exit': installed.returncode,
                                                 'stdout': installed.stdout, 'stderr': installed.stderr}, indent=2))
    if installed.returncode:
        raise RuntimeError('npm install failed; private capture retained at ' + str(root))
    cli = json.loads((prefix / 'lib/node_modules/@twin-cli/cli/package.json').read_text())
    core = json.loads((prefix / 'lib/node_modules/@twin-cli/cli/node_modules/@twin-cli/core/package.json').read_text())
    assert cli['version'] == core['version'] == '0.1.0'
    assert cli['dependencies']['@twin-cli/core'] == '0.1.0'
    env['PATH'] = str(prefix / 'bin') + ':' + env['PATH']
    (project / '.gitignore').write_text('ignored-input.txt\n')
    (project / 'ignored-input.txt').write_text('demo-only\n')
    (project / 'message.txt').write_text('before\n')
    (project / 'package.json').write_text('{"name":"twin-fixed-demo","private":true}\n')
    (project / 'demo.cjs').write_text(ACTION)
    for args in (['init', '-q'], ['config', 'user.name', 'Twin scripted demo'],
                 ['config', 'user.email', 'demo@example.invalid'], ['config', 'commit.gpgsign', 'false'],
                 ['add', '.'], ['commit', '-qm', 'Disposable baseline']):
        subprocess.run(['git', *args], cwd=project, env=env, capture_output=True, check=True)
    ignored = subprocess.run(['git', 'check-ignore', 'ignored-input.txt'], cwd=project,
                             env=env, capture_output=True, text=True, check=True).stdout
    events = []
    start = time.monotonic()

    def emit(value):
        events.append([round(time.monotonic() - start, 6), 'o', value])
        print(value, end='', flush=True)

    before = (project / 'message.txt').read_bytes()
    emit('Scripted demonstration · published @twin-cli/cli@0.1.0 · no AI agent\r\n')
    emit('$ git check-ignore ignored-input.txt\r\n' + ignored.replace('\n', '\r\n'))
    emit('$ cat message.txt  # original before run\r\n' + before.decode().replace('\n', '\r\n'))
    time.sleep(0.6)
    emit('$ ' + COMMAND + '\r\n')
    master, slave = pty.openpty()
    process = subprocess.Popen(['twin', 'run', '--receipt=text', '--review', '--', 'node', 'demo.cjs'],
                               cwd=project, env=env, stdin=slave, stdout=slave, stderr=slave,
                               start_new_session=True)
    os.close(slave)
    output = b''
    decoder = codecs.getincrementaldecoder('utf-8')()
    applied = False
    review_before = None
    deadline = time.monotonic() + 30
    while True:
        if time.monotonic() > deadline:
            raise RuntimeError('timeout; fixture retained at ' + str(root))
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            output += chunk
            decoded = decoder.decode(chunk)
            events.append([round(time.monotonic() - start, 6), 'o', decoded])
            print(decoded, end='', flush=True)
            if not applied and b'(EOF or another answer retains copy): ' in output:
                review_before = (project / 'message.txt').read_bytes()
                assert review_before == before == b'before\n'
                marker = json.loads((root / 'action.json').read_text())
                assert Path(marker['cwd']).resolve() != project.resolve()
                assert (Path(marker['cwd']) / 'message.txt').read_bytes() == b'after\n'
                assert (Path(marker['cwd']) / 'ignored-input.txt').read_bytes() == b'demo-only\n'
                assert absent(marker['pid']) and absent(-marker['group'])
                time.sleep(1)
                events.append([round(time.monotonic() - start, 6), 'i', 'apply\n'])
                os.write(master, b'apply\n')
                applied = True
    os.close(master)
    assert decoder.decode(b'', final=True) == ''
    exit_code = process.wait(timeout=5)
    text = output.decode('utf-8')
    after = (project / 'message.txt').read_bytes()
    marker = json.loads((root / 'action.json').read_text())
    assert exit_code == 0 and applied and after == b'after\n'
    for line in ('modified [tracked] message.txt', 'settlement observed', 'final group: absent',
                 'Captured pipes: closed', 'Twin apply applied: 1 changes'):
        assert line in text, line
    assert absent(marker['pid']) and absent(-marker['group'])
    assert absent(process.pid) and absent(-process.pid)
    assert not Path(marker['cwd']).exists()
    assert not Path(marker['cwd']).parent.parent.exists()
    assert not list(scratch.glob('twin-cli-*'))
    emit('$ cat message.txt  # original after apply\r\n' + after.decode().replace('\n', '\r\n'))
    emit('twin exit: 0; direct child/group absent; copy removed\r\n')
    header = {'version': 2, 'width': 100, 'height': 32, 'title': 'Twin 0.1.0 scripted review/apply demonstration',
              'env': {'TERM': 'dumb'}}
    transcript = ''.join(event[2] for event in events if event[1] == 'o').replace('\r\n', '\n')
    assert str(root) not in transcript and str(Path(node).parent) not in transcript
    verification = {'packageSource': 'https://registry.npmjs.org', 'cli': '@twin-cli/cli@' + cli['version'],
                    'recordedAtUtc': datetime.now(timezone.utc).isoformat(),
                    'npmInstallExit': installed.returncode, 'npmInstallStdout': installed.stdout,
                    'npmInstallStderr': installed.stderr,
                    'core': '@twin-cli/core@' + core['version'], 'coreDependency': cli['dependencies']['@twin-cli/core'],
                    'node': subprocess.check_output([node, '--version'], env=env, text=True).strip(),
                    'command': COMMAND, 'stdin': 'apply\n', 'exitCode': exit_code,
                    'originalBeforeHex': before.hex(), 'originalAtReviewHex': review_before.hex(),
                    'originalAfterHex': after.hex(), 'ignoredInputHex': b'demo-only\n'.hex(),
                    'originalBeforeSha256': hashlib.sha256(before).hexdigest(),
                    'originalAfterSha256': hashlib.sha256(after).hexdigest(),
                    'copyHadIgnoredInput': True, 'copyEditedBeforeApply': True,
                    'directChildAbsentBeforeApply': True, 'processGroupAbsentBeforeApply': True,
                    'directChildAndGroupAbsentAfterApply': True, 'cliAndGroupAbsent': True,
                    'copyAndScratchRemovedByTwin': True, 'privatePathsInRecording': False,
                    'redactions': [], 'capture': 'PTY combines stdout/stderr; input event and terminal echo retained'}
    shutil.rmtree(root)
    assert not root.exists()
    verification['ownedFixtureHomePrefixCacheRemoved'] = True
    (destination / 'demo.cast').write_text('\n'.join(json.dumps(item, ensure_ascii=False) for item in [header, *events]) + '\n')
    (destination / 'transcript.txt').write_text(transcript)
    (destination / 'verification.json').write_text(json.dumps(verification, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record', type=Path, help='new output directory; installs published 0.1.0 into a disposable prefix')
    parser.add_argument('--replay', type=Path, help='asciinema v2 file; Ctrl-C stops playback')
    parser.add_argument('--static', action='store_true', help='print without motion or delays')
    args = parser.parse_args()
    if bool(args.record) == bool(args.replay):
        parser.error('choose exactly one of --record or --replay')
    if args.record:
        record(args.record)
    else:
        replay(args.replay, args.static)
