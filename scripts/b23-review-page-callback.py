from pathlib import Path
import io
import os
import shutil
import subprocess
import tarfile
import tempfile

repo = Path.cwd()
with tempfile.TemporaryDirectory(prefix='b23-r2-') as scratch:
    mirror = Path(scratch)
    archive = subprocess.check_output(['git', 'archive', 'HEAD'])
    with tarfile.open(fileobj=io.BytesIO(archive)) as tree:
        tree.extractall(mirror, filter='data')
    (mirror / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
    (mirror / '.svelte-kit').mkdir()
    shutil.copy2(repo / '.svelte-kit/tsconfig.json', mirror / '.svelte-kit/tsconfig.json')
    command = ['fnm', 'exec', '--using=.nvmrc', '--', 'node', '--import', 'tsx',
               '--import', './src/lib/skin/register-node.ts', '--experimental-test-module-mocks',
               '--test', 'src/lib/callback-path.test.ts']
    environment = {**os.environ, 'SKIN_DIR': 'skin/default'}
    baseline = subprocess.run(command, cwd=mirror, env=environment, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert baseline.returncode == 0, baseline.stdout
    page = mirror / 'src/routes/group/[slug]/+page.svelte'
    source = page.read_text()
    assert 'callbackUrl={loginCallback}' in source
    page.write_text(source.replace('callbackUrl={loginCallback}',
                                   'callbackUrl={nextParam ?? loginCallback}'))
    mutant = subprocess.run(command, cwd=mirror, env=environment, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print('Baseline exit:', baseline.returncode)
    print('Unsafe page target exit:', mutant.returncode)
    print(mutant.stdout)
    assert mutant.returncode != 0, (
        'R2: mapped tests accept the page passing raw next to LoginModal, including /\\evil.example'
    )
