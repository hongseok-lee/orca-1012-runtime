#!/usr/bin/env python3
"""Assigned single-Pod backup/restore and one-shot immediate-shutdown evidence."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import time

from storage_deployment_io import kubectl_args, resource_name


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sql_name(value):
    if not re.fullmatch(r'[a-z][a-z0-9_]{0,62}', value):
        raise ValueError('Expected a lowercase SQL identifier.')
    return value


class Probe:
    def __init__(self, args):
        self.args = args
        self.base = kubectl_args(args.kubeconfig, args.context, args.namespace)
        self.directory = args.private_dir.expanduser().resolve()
        checkout = Path(__file__).resolve().parents[4]
        if checkout == self.directory or checkout in self.directory.parents:
            raise ValueError('Private backup/evidence must be outside the checkout.')
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if stat.S_IMODE(self.directory.stat().st_mode) != 0o700:
            raise ValueError('Private directory must have mode 0700.')
        self.exec = self.base + ['exec', '-i', args.pod, '-c', 'postgres', '--']

    def run(self, command, data=None, check=True, timeout=60):
        response = subprocess.run(command, input=data, capture_output=True, timeout=timeout)
        if check and response.returncode:
            raise RuntimeError('Assigned command failed; credential-bearing output suppressed.')
        return response

    def save(self, name, value):
        with (self.directory / name).open('x', encoding='utf-8') as output:
            os.chmod(output.name, 0o600)
            json.dump(value, output, indent=2)
            output.write('\n')

    def sql(self, query, database=None, check=True):
        return self.run(self.exec + ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                        '-U', 'postgres', '-d', database or self.args.database],
                        query.encode(), check=check, timeout=15)

    def query(self, query, database=None):
        return json.loads(self.sql(query, database).stdout)

    def guard(self):
        pod = json.loads(self.run(self.base + ['get', 'pod', self.args.pod, '-o', 'json']).stdout)
        if (pod['metadata']['uid'] != self.args.pod_uid
                or pod['metadata'].get('labels', {}).get('orca.dev/dataset') != self.args.dataset
                or len(pod['spec']['containers']) != 1
                or pod['spec']['containers'][0]['name'] != 'postgres'):
            raise ValueError('Pod UID/dataset/single-container target does not match.')
        claims = [v['persistentVolumeClaim']['claimName'] for v in pod['spec']['volumes']
                  if 'persistentVolumeClaim' in v]
        if len(claims) != 1:
            raise ValueError('Expected exactly one PostgreSQL block claim.')
        pvc = json.loads(self.run(self.base + ['get', 'pvc', claims[0], '-o', 'json']).stdout)
        if pvc['spec']['volumeName'] != self.args.pv_name or pvc['status']['phase'] != 'Bound':
            raise ValueError('Bound PostgreSQL PV does not match the assigned disk.')
        cs = pod['status']['containerStatuses'][0]
        return {'observed_at': utc(), 'pod_uid': pod['metadata']['uid'],
                'node': pod['spec']['nodeName'], 'pv_name': pvc['spec']['volumeName'],
                'pvc_uid': pvc['metadata']['uid'], 'container': cs}

    def fingerprint(self, database):
        schema = self.run(self.exec + ['pg_dump', '-U', 'postgres', '-d', database,
                                     '--schema-only', '--no-owner', '--no-privileges']).stdout
        # Restrict keys and comments vary between equivalent pg_dump invocations.
        lines = [line for line in schema.splitlines() if line.strip()
                 and not line.startswith((b'--', b'\\restrict', b'\\unrestrict'))]
        return hashlib.sha256(b'\n'.join(lines)).hexdigest()

    def fixture(self, schema, database=None):
        return self.query(f"SELECT json_build_object('count',count(*),'hash',"
                          f"md5(coalesce(string_agg(id::text||':'||marker,'|' ORDER BY id),'')),"
                          f"'ids',coalesce(json_agg(id ORDER BY id),'[]'::json)) FROM {schema}.markers;",
                          database)

    def identity(self):
        sql = self.query("SELECT json_build_object('server_start',pg_postmaster_start_time(),"
                         "'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),"
                         "'data_directory',current_setting('data_directory'),'wal_flush_lsn',"
                         "pg_current_wal_flush_lsn(),'fsync',current_setting('fsync'),"
                         "'synchronous_commit',current_setting('synchronous_commit'),"
                         "'full_page_writes',current_setting('full_page_writes'));")
        shell = self.run(self.exec + ['sh', '-ec', '''
          read pid < "$PGDATA/postmaster.pid"
          printf 'postmaster_pid=%s\n' "$pid"
          cat "/proc/$pid/comm"
          stat -Lc 'data_dir_device_inode=%d:%i' "$PGDATA"
          stat -Lc 'wal_dir_device_inode=%d:%i' "$PGDATA/pg_wal"
          for f in /proc/[0-9]*/comm; do
            read comm < "$f" || continue
            if [ "$comm" = postgres ]; then
              dir=${f%/comm}; printf 'postgres_pid=%s ' "${dir##*/}"
              sed -n '/^PPid:/p' "$dir/status"
            fi
          done
        ''']).stdout.decode()
        return {'sql': sql, 'process_and_filesystem': shell, 'placement': self.guard()}

    def backup_restore(self):
        self.guard()
        self.save('backup-attempt.json', {'at': utc()})
        case = secrets.token_hex(4)
        schema = 'p1_01_recovery_' + case
        restore = 'p1_01_restore_' + case
        self.sql(f"BEGIN; CREATE SCHEMA {schema}; CREATE TABLE {schema}.markers "
                 "(id integer PRIMARY KEY,marker text NOT NULL); "
                 f"INSERT INTO {schema}.markers VALUES(1,'before_backup'); COMMIT;")
        original = {'schema_hash': self.fingerprint(self.args.database),
                    'fixture': self.fixture(schema), 'identity': self.identity()}
        dump = self.directory / ('database-' + case + '.dump')
        started = utc()
        with dump.open('xb') as output:
            os.chmod(dump, 0o600)
            result = subprocess.run(self.exec + ['pg_dump', '-U', 'postgres', '-d',
                                    self.args.database, '--format=custom'], stdout=output,
                                    stderr=subprocess.PIPE, timeout=120)
        if result.returncode or result.stderr:
            raise RuntimeError('Dump failed or emitted warnings; stop before restore/fault.')
        content = dump.read_bytes()
        if not content.startswith(b'PGDMP'):
            raise ValueError('Custom-format archive header missing.')
        self.sql(f'CREATE DATABASE {restore} TEMPLATE template0;', 'postgres')
        self.run(self.exec + ['pg_restore', '-U', 'postgres', '-d', restore,
                             '--exit-on-error', '--single-transaction'], content, timeout=120)
        restored = {'schema_hash': self.fingerprint(restore), 'fixture': self.fixture(schema, restore)}
        if original['schema_hash'] != restored['schema_hash'] or original['fixture'] != restored['fixture']:
            raise ValueError('Restored schema/fixture comparison failed; do not inject fault.')
        self.save('backup-restore.json', {'started_at': started, 'completed_at': utc(),
                  'schema': schema, 'restore_database': restore, 'original': original,
                  'restored': restored, 'backup_file': str(dump), 'backup_bytes': len(content),
                  'backup_sha256': hashlib.sha256(content).hexdigest(), 'verified': True,
                  'limits': 'Logical single-DB snapshot; no global roles, PITR or separate server/volume proof.'})
        print('Backup/isolated DB restore verified; no dump or credential output.')

    def crash_once(self):
        backup = json.loads((self.directory / 'backup-restore.json').read_text())
        if not backup['verified']:
            raise ValueError('Verified backup/restore is required first.')
        schema = sql_name(backup['schema'])
        self.guard()
        self.save('fault-attempt.json', {'at': utc(), 'method': 'postmaster SIGQUIT/immediate, without shutdown checkpoint',
                  'one_shot': True, 'operator_fault_ownership_required': True})
        self.sql(f"BEGIN; INSERT INTO {schema}.markers VALUES(2,'committed_before_fault'); COMMIT;")
        before = self.identity()
        if any(before['sql'][k] != 'on' for k in ['fsync', 'synchronous_commit', 'full_page_writes']):
            raise ValueError('Durability settings changed; no fault sent.')
        application = 'p1_01_hold_' + schema.removeprefix('p1_01_recovery_')
        with (self.directory / 'transaction-session.txt').open('xb') as log:
            os.chmod(log.name, 0o600)
            held = subprocess.Popen(self.exec + ['env', 'PGAPPNAME=' + application,
                      'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d',
                      self.args.database], stdin=subprocess.PIPE, stdout=log, stderr=log)
            held.stdin.write(f"BEGIN; INSERT INTO {schema}.markers VALUES(3,'uncommitted_before_fault'); "
                             "SELECT pg_sleep(120); ROLLBACK;\n".encode())
            held.stdin.close()
            transaction = None
            for _ in range(20):
                transaction = self.query("SELECT coalesce(json_agg(json_build_object('pid',pid,"
                           "'backend_xid',backend_xid::text,'state',state,'wait_event',wait_event)),"
                           f"'[]'::json) FROM pg_stat_activity WHERE application_name='{application}';")
                if transaction and transaction[0]['backend_xid'] and transaction[0]['wait_event'] == 'PgSleep':
                    break
                time.sleep(0.25)
            if not transaction or transaction[0]['wait_event'] != 'PgSleep':
                raise ValueError('Could not observe open fixture transaction; no fault sent.')
            assert self.fixture(schema)['ids'] == [1, 2]
            self.save('before-fault.json', {'identity': before, 'held_transaction': transaction,
                                          'fixture': self.fixture(schema), 'at': utc()})
            self.guard()
            sent = utc()
            # SIGQUIT is PostgreSQL immediate shutdown: no normal checkpoint.
            fault = self.run(self.exec + ['sh', '-ec', '''
              read pid < "$PGDATA/postmaster.pid"
              [ "$pid" = 1 ]
              read comm < "/proc/$pid/comm"
              [ "$comm" = postgres ]
              kill -QUIT "$pid"
            '''], check=False, timeout=15)
            samples = []
            after = None
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                started = utc()
                ping = self.sql('SELECT 1;', check=False)
                samples.append({'at': started, 'exit': ping.returncode, 'sql_ok': ping.stdout.strip() == b'1'})
                if ping.returncode == 0 and ping.stdout.strip() == b'1':
                    placement = self.guard()
                    if placement['container']['restartCount'] == before['placement']['container']['restartCount'] + 1:
                        after = self.identity()
                        break
                time.sleep(0.25)
            if after is None:
                raise RuntimeError('Recovery not confirmed within90s; no second fault is allowed.')
            held.wait(timeout=15)
        result = self.fixture(schema)
        if result['ids'] != [1, 2]:
            raise ValueError('Committed/uncommitted recovery distinction failed.')
        for key in ['system_identifier', 'data_directory']:
            assert before['sql'][key] == after['sql'][key]
        assert before['sql']['server_start'] != after['sql']['server_start']
        assert before['placement']['pv_name'] == after['placement']['pv_name']
        assert before['placement']['container']['containerID'] != after['placement']['container']['containerID']
        raw = self.run(self.base + ['logs', self.args.pod, '-c', 'postgres', '--timestamps']).stdout.decode()
        prefixes = ('database system was interrupted', 'database system was not properly shut down',
                    'redo starts at', 'redo done at', 'invalid record length at',
                    'database system is ready to accept connections', 'checkpoint starting: end-of-recovery',
                    'checkpoint complete:')
        recovery = [line for line in raw.splitlines() if 'LOG:  ' in line
                    and line.split('LOG:  ', 1)[1].startswith(prefixes)]
        self.save('crash-recovery.json', {'signal_sent_at': sent, 'completed_at': utc(),
                  'signal_command_exit': fault.returncode, 'method': 'PostgreSQL SIGQUIT immediate shutdown',
                  'before': before, 'after': after, 'fixture': result,
                  'sql_availability_samples': samples, 'selected_recovery_logs': recovery,
                  'committed_survived': True, 'uncommitted_absent': True,
                  'spot_compute_loss_tested': False, 'product_durable_ack_tested': False})
        print('One-shot immediate shutdown recovered: committed retained, uncommitted absent.')

    def writer_lock(self):
        self.guard()
        self.save('writer-lock-attempt.json', {'at': utc()})
        result = self.run(self.exec + ['sh', '-ec', '''
          read pid < "$PGDATA/postmaster.pid"
          read comm < "/proc/$pid/comm"
          [ "$pid" = 1 ] && [ "$comm" = postgres ]
          exec timeout 5s postgres -D "$PGDATA"
        '''], check=False, timeout=10)
        lock_rejected = result.returncode != 0 and b'lock file "postmaster.pid" already exists' in result.stderr
        self.save('writer-lock.json', {'at': utc(), 'exit': result.returncode,
                  'postmaster_pid_lock_rejected': lock_rejected, 'identity': self.identity(),
                  'limit': 'Data-directory lock in the same container; not cross-node CSI fencing.'})
        if not lock_rejected:
            raise ValueError('Second postmaster rejection not proven; report without retry.')
        print('Existing postmaster.pid rejected same-directory second postmaster.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['backup-restore', 'crash-once', 'writer-lock'])
    for field in ['kubeconfig', 'context', 'pod-uid', 'pv-name']:
        parser.add_argument('--' + field, required=True)
    for field in ['namespace', 'dataset', 'pod']:
        parser.add_argument('--' + field, required=True, type=resource_name)
    parser.add_argument('--database', required=True, type=sql_name)
    parser.add_argument('--private-dir', required=True, type=Path)
    parser.add_argument('--root-assigned', action='store_true')
    args = parser.parse_args()
    if not args.root_assigned:
        parser.error('Execution requires root-assigned exclusive fault ownership.')
    os.umask(0o077)
    probe = Probe(args)
    getattr(probe, args.phase.replace('-', '_'))()


if __name__ == '__main__':
    main()
