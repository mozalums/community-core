import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest


class ThrottledB2(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, retry_after=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        if retry_after:
            self.send_header('Retry-After', retry_after)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.server.requests.append(self.path)
        url = f'http://127.0.0.1:{self.server.server_port}'
        self.reply(200, {
            'accountId': 'audit', 'authorizationToken': 'audit',
            'apiUrl': url, 'downloadUrl': url,
            'allowed': {'bucketId': 'audit-id', 'bucketName': 'audit-bucket',
                        'capabilities': ['listFiles', 'readFiles', 'writeFiles', 'deleteFiles']},
        })

    def do_HEAD(self):
        self.server.requests.append(self.path)
        self.send_response(503)
        self.send_header('Retry-After', '600')
        self.end_headers()

    def do_POST(self):
        self.server.requests.append(self.path)
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.reply(503, {'status': 503, 'code': 'service_unavailable',
                         'message': 'retry later'}, retry_after='600')


class B2DeadlineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ('deploy', 'bin', 'secrets', 'staging'):
            (self.root / name).mkdir()
        shutil.copy(os.environ.get('BACKUP_SH', str(Path.cwd() / 'deploy/backup.sh')),
                    self.root / 'deploy/backup.sh')
        docker = self.root / 'bin/docker'
        docker.write_text('''#!/usr/bin/env bash
[[ $1 == compose && $2 == version ]] && exit 0
for arg; do
    case $arg in DUMP_NAME=*) name=${arg#*=} ;; esac
done
printf 'PGDMP audit fixture\\n' >"$LOREM_BACKUP_DIR/$name"
''')
        docker.chmod(0o755)
        subprocess.run(['age-keygen', '-o', str(self.root / 'key')],
                       check=True, capture_output=True)
        recipient = subprocess.check_output(
            ['age-keygen', '-y', str(self.root / 'key')], text=True).strip()
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ThrottledB2)
        self.server.requests = []
        thread = threading.Thread(target=self.server.serve_forever)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        config = self.root / 'rclone.conf'
        config.write_text(f'''[audit]
type = b2
account = audit
key = audit
endpoint = http://127.0.0.1:{self.server.server_port}
''')
        secrets = self.root / 'secrets/backup.env'
        secrets.write_text(f'''BACKUP_RCLONE_REMOTE=audit:audit-bucket/postgres
BACKUP_AGE_RECIPIENTS={recipient}
RCLONE_CONFIG={config}
BACKUP_HEARTBEAT_OPTIONAL=true
''')
        secrets.chmod(0o600)
        self.env = dict(os.environ, BACKUP_PROBE_DEADLINE='3', BACKUP_LIST_DEADLINE='3',
                        BACKUP_UPLOAD_DEADLINE='3', BACKUP_HEARTBEAT_DEADLINE='3', PATH=f'{self.root}/bin:' + os.environ['PATH'],
                        LOREM_SECRETS_DIR=str(self.root / 'secrets'),
                        LOREM_BACKUP_DIR=str(self.root / 'staging'),
                        LOREM_BACKUP_LOCK=str(self.root / 'lock'))

    def test_probe_stops_at_its_deadline_on_b2_throttle(self):
        result = subprocess.run(['timeout', '20', 'bash',
                                 str(self.root / 'deploy/backup.sh'), '--dry-run'],
                                env=self.env, capture_output=True, text=True)
        self.assertIn('/file/audit-bucket/postgres', self.server.requests)
        self.assertEqual(result.returncode, 5,
                         f'probe rc={result.returncode}; expected 5 before 20s; '
                         f'requests={self.server.requests}')

    def test_full_run_takes_dump_when_b2_throttles(self):
        result = subprocess.run(['timeout', '30', 'bash',
                                 str(self.root / 'deploy/backup.sh'), '--quiet'],
                                env=self.env, capture_output=True, text=True)
        self.assertIn('/file/audit-bucket/postgres', self.server.requests)
        dumps = list((self.root / 'staging').glob('*.dump.age'))
        self.assertEqual(len(dumps), 1,
                         f'run rc={result.returncode}; encrypted dumps={len(dumps)} after 30s; '
                         f'requests={self.server.requests}')
        self.assertGreater(dumps[0].stat().st_size, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
