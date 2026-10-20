"""Run browser acceptance against the real local service; no install, no provider access."""
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
CLI = '/Users/huangbo/.npm/_npx/31e32ef8478fbf80/node_modules/@playwright/cli/playwright-cli.js'
PORT = 4199
DATA_ROOT = ROOT / 'evidence' / 'run-data'
SHOTS = ROOT / 'evidence' / 'screenshots'

env = dict(os.environ, PWTEST_DAEMON_SESSION_DIR='/tmp/data-mcps-product-browser')
logs = []

def run(args, extra_env=None):
    e = dict(env)
    if extra_env:
        e.update(extra_env)
    result = subprocess.run(['node', CLI, '-s=data-mcps-product-check'] + args, cwd=ROOT, env=e, text=True, capture_output=True)
    logs.append(result.stdout + result.stderr)
    return result

def main():
    if DATA_ROOT.exists():
        shutil.rmtree(DATA_ROOT)
    SHOTS.mkdir(parents=True, exist_ok=True)
    server = subprocess.Popen(
        ['node', 'dist/cli.js', 'ui', '-p', str(PORT), '--data-root', str(DATA_ROOT)],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        base = f'http://127.0.0.1:{PORT}'
        for _ in range(50):
            if server.poll() is not None:
                print('server exited early:', server.stdout.read()[-500:] if server.stdout else '')
                return 1
            try:
                urllib.request.urlopen(base + '/api/v1/sources', timeout=1)
                break
            except Exception:
                time.sleep(0.2)
        else:
            print('server did not start')
            return 1
        # 防呆：确认对答的是本脚本刚创建的 dataRoot（防端口被旧实例占用）
        marker = DATA_ROOT / 'projects' / 'default.json'
        if not marker.exists():
            print('data root marker missing — possibly a stale server on this port')
            return 1
        opened = run(['open', base, '--config=.playwright/cli.config.json'])
        if opened.returncode:
            print(opened.stdout[-3000:])
            return opened.returncode
        template = (ROOT / 'test' / 'ui' / 'browser-check.js').read_text()
        runnable = template.replace('__BASE_URL__', base).replace('__SHOT_DIR__', str(SHOTS))
        (ROOT / 'test' / 'ui' / '.browser-check.run.js').write_text(runnable)
        tested = run(['run-code', '--filename=test/ui/.browser-check.run.js'])
        matches = re.findall(r'### Result\s*\n(\{[^\n]+\})', tested.stdout)
        if not matches:
            matches = re.findall(r'DATA_MCPS_CHECKS=(\{[^\n]+\})', tested.stdout)
        report = json.loads(matches[-1]) if matches else {'passed': 0, 'failed': 1, 'error': 'no report', 'tail': tested.stdout[-2000:]}
        (ROOT / 'evidence' / 'browser-checks.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        run(['close'])
        print(json.dumps({k: report[k] for k in ('passed', 'failed')}, ensure_ascii=False))
        if report.get('error'):
            print(report['error'])
        return 1 if report['failed'] else 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except Exception:
            server.kill()
        (ROOT / 'evidence' / 'browser-cli.log').write_text('\n'.join(logs)[-20000:])

if __name__ == '__main__':
    sys.exit(main())
