#!/usr/bin/env python3
"""Read-only inventory of fixed candidate mounts for separate VFS exec state."""
import errno
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import stat
import sys

from owned_mounts import _decode, _directory, _unique_mount

MIN_FREE_BYTES=256*1024*1024
MIN_FREE_INODES=4096
FILESYSTEMS=('tmpfs','ext4','xfs','btrfs','overlay','other')
PROPAGATIONS=('private','slave','shared','shared-slave')
BOOLEANS=('writable','executable','nosuid','nodev','secure_owner','secure_mode','mount_identity_verified')


def mount_rows():
    with open('/proc/self/mountinfo') as stream:contents=stream.read(1048577)
    if len(contents.encode())>1048576:raise ValueError('mount table bound')
    rows={}
    for line in contents.splitlines():
        fields=line.split();separator=fields.index('-')
        if separator<6 or len(fields)!=separator+4:raise ValueError('mount row invalid')
        identity=int(fields[0]);point=_decode(fields[4])
        if identity in rows or not point.startswith('/') or '..' in PurePosixPath(point).parts:
            raise ValueError('mount identity invalid')
        rows[identity]={'point':point,'filesystem':fields[separator+1],
                        'options':set(fields[5].split(','))|set(fields[separator+3].split(',')),
                        'shared':any(value.startswith('shared:') for value in fields[6:separator]),
                        'slave':any(value.startswith('master:') for value in fields[6:separator])}
    if not rows:raise ValueError('mount table empty')
    return rows


def memory_available():
    with open('/proc/meminfo') as stream:contents=stream.read(65537)
    if len(contents.encode())>65536:raise ValueError('memory table bound')
    found=re.findall(r'^MemAvailable:\s+([0-9]+) kB$',contents,re.MULTILINE)
    if len(found)!=1:raise ValueError('memory availability unverified')
    return int(found[0])*1024


def inspect_parent(label,path):
    """Open only the candidate directory and proc metadata; allocate nothing."""
    if platform.system()!='Linux':raise ValueError('Linux mount evidence required')
    candidate=Path(path)
    if not candidate.is_absolute() or '..' in candidate.parts:raise ValueError('candidate invalid')
    descriptor=_directory(candidate.parts[1:])
    try:
        unique=_unique_mount(descriptor)
        record=os.fstat(descriptor);space=os.fstatvfs(descriptor)
        with open('/proc/self/fdinfo/'+str(descriptor)) as stream:info=stream.read(4097)
        if len(info)>4096:raise ValueError('descriptor info bound')
        ids=[int(row.split(':',1)[1]) for row in info.splitlines() if row.startswith('mnt_id:')]
        if len(ids)!=1:raise ValueError('descriptor mount unverified')
        initial=mount_rows();row=initial.get(ids[0])
        if row is None or not (str(candidate)==row['point'] or str(candidate).startswith(row['point'].rstrip('/')+'/')):
            raise ValueError('candidate mount unverified')
        if mount_rows().get(ids[0])!=row or _unique_mount(descriptor)!=unique:
            raise ValueError('candidate mount changed')
        flags=row['options'];filesystem=row['filesystem']
        propagation=('shared-slave' if row['shared'] and row['slave'] else
                     'shared' if row['shared'] else 'slave' if row['slave'] else 'private')
        return {'filesystem':filesystem if filesystem in FILESYSTEMS else 'other',
                'propagation':propagation,'writable':'ro' not in flags and not bool(space.f_flag & os.ST_RDONLY),
                'executable':'noexec' not in flags,'nosuid':'nosuid' in flags,'nodev':'nodev' in flags,
                'secure_owner':record.st_uid==0 or (label=='runner-temp' and record.st_uid==os.getuid()),
                'secure_mode':not bool(record.st_mode & 0o022) or (record.st_uid==0 and bool(record.st_mode & stat.S_ISVTX)),
                'mount_identity_verified':True,'free_bytes':space.f_bavail*space.f_frsize,'free_inodes':space.f_favail,
                'memory_available_bytes':memory_available()}
    finally:os.close(descriptor)


def assess(label,measured):
    """Publish only fixed facts; a conventional pathname grants no eligibility."""
    if (type(measured) is not dict or measured.get('filesystem') not in FILESYSTEMS
            or measured.get('propagation') not in PROPAGATIONS
            or any(type(measured.get(key)) is not bool for key in BOOLEANS)
            or any(type(measured.get(key)) is not int or not 0<=measured[key]<2**63 for key in ('free_bytes','free_inodes','memory_available_bytes'))):
        raise ValueError('candidate measurement invalid')
    facts={key:measured[key] for key in ('filesystem','propagation',*BOOLEANS,'free_bytes','free_inodes','memory_available_bytes')}
    reason='eligible'
    if not facts['mount_identity_verified']:reason='mount-unverified'
    elif facts['propagation'] in ('shared','shared-slave'):reason='shared-parent'
    elif facts['propagation']=='slave':reason='slave-parent'
    elif not facts['secure_owner'] or not facts['secure_mode']:reason='unsafe-ownership'
    elif facts['filesystem'] not in ('tmpfs','ext4','xfs','btrfs'):reason='unsupported-filesystem'
    elif not facts['writable']:reason='read-only'
    elif facts['free_bytes']<MIN_FREE_BYTES:reason='insufficient-capacity'
    elif facts['free_inodes']<MIN_FREE_INODES:reason='insufficient-inodes'
    elif facts['filesystem']=='tmpfs' and facts['memory_available_bytes']<MIN_FREE_BYTES:reason='insufficient-memory'
    # noexec is allowed only for exec-state eligibility. No whole-data-root claim.
    return dict(facts,candidate=label,status='observed',reason=reason,exec_state_eligible=reason=='eligible')


def candidate_report(inspector=inspect_parent):
    fixed=(('runner-temp',os.environ.get('RUNNER_TEMP','')),('shm','/dev/shm'),
           ('run','/run'),('mnt','/mnt'),('tmp','/tmp'))
    candidates=[]
    for label,path in fixed:
        try:record=assess(label,inspector(label,path))
        except OSError as error:
            reason={errno.ENOENT:'missing',errno.ENOTDIR:'not-directory',errno.ELOOP:'symlink'}.get(error.errno,'inspection-failed')
            record={'candidate':label,'status':'unavailable','reason':reason,'exec_state_eligible':False}
        except (ValueError,TypeError,IndexError,AttributeError):
            record={'candidate':label,'status':'unavailable','reason':'unverified','exec_state_eligible':False}
        candidates.append(record)
    return {'schema_version':1,'scope':'existing-private-exec-staging','exec_state_only':True,
            'allocation_attempted':False,'minimum_free_bytes':MIN_FREE_BYTES,'minimum_free_inodes':MIN_FREE_INODES,
            'minimum_tmpfs_memory_available_bytes':MIN_FREE_BYTES,
            'any_eligible':any(row['exec_state_eligible'] for row in candidates),'candidates':candidates}


if __name__=='__main__':
    report=candidate_report()
    print(json.dumps(report,separators=(',',':'),sort_keys=True))
    # No eligible parent is a valid measurement, never a compatibility success.
    # Complete inability to observe any fixed candidate is a diagnostic failure.
    raise SystemExit(0 if any(row['status']=='observed' for row in report['candidates']) else 1)
