import http.server
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest


class ThrottledMonitor(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.requests.append(self.path)
        self.send_response(503)
        self.send_header('Retry-After', '7200')
        self.send_header('Content-Length', '0')
        self.end_headers()


class HeartbeatDeadlineTest(unittest.TestCase):
    def test_heartbeat_obeys_documented_wait_ceiling(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('deploy', 'bin', 'secrets', 'staging', 'remote'):
                (root / name).mkdir()
            shutil.copy(os.environ.get('BACKUP_SH', str(Path.cwd() / 'deploy/backup.sh')),
                        root / 'deploy/backup.sh')
            docker = root / 'bin/docker'
            docker.write_text('''#!/usr/bin/env bash
[[ $1 == compose && $2 == version ]] && exit 0
for arg; do
    case $arg in DUMP_NAME=*) name=${arg#*=} ;; esac
done
printf 'PGDMP audit fixture\\n' >"$LOREM_BACKUP_DIR/$name"
''')
            docker.chmod(0o755)
            subprocess.run(['age-keygen', '-o', str(root / 'key')],
                           check=True, capture_output=True)
            recipient = subprocess.check_output(
                ['age-keygen', '-y', str(root / 'key')], text=True).strip()
            (root / 'rclone.conf').write_text('')
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ThrottledMonitor)
            server.requests = []
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                secrets = root / 'secrets/backup.env'
                secrets.write_text(f'''BACKUP_RCLONE_REMOTE={root / 'remote'}
BACKUP_AGE_RECIPIENTS={recipient}
RCLONE_CONFIG={root / 'rclone.conf'}
BACKUP_HEARTBEAT_URL=http://127.0.0.1:{server.server_port}/ping
''')
                secrets.chmod(0o600)
                env = dict(os.environ, PATH=f'{root}/bin:' + os.environ['PATH'],
                           LOREM_SECRETS_DIR=str(root / 'secrets'),
                           LOREM_BACKUP_DIR=str(root / 'staging'),
                           LOREM_BACKUP_LOCK=str(root / 'lock'))
                start = time.monotonic()
                result = subprocess.run(['timeout', '-k', '5', '90', 'bash',
                                         str(root / 'deploy/backup.sh'), '--quiet'],
                                        env=env, capture_output=True, text=True)
                elapsed = time.monotonic() - start
                remote = list((root / 'remote').glob('*.dump.age'))
                queued = list((root / 'staging').glob('*.dump.age'))
                print(f'rc={result.returncode} elapsed={elapsed:.1f}s '
                      f'uploaded={len(remote)} queued={len(queued)} '
                      f'heartbeat_requests={server.requests}', flush=True)
                print(result.stderr, flush=True)
                self.assertEqual(len(remote), 1)
                self.assertGreater(remote[0].stat().st_size, 0)
                self.assertEqual(queued, [])
                self.assertIn('/ping', server.requests)
                self.assertEqual(result.returncode, 0,
                                 'heartbeat exceeded its documented ~75s budget; '
                                 'the outer 90s watchdog killed a successful backup')
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main(verbosity=2)
