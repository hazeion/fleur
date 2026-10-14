"""Ordinary unmount of the two mount classes created by an owned Docker daemon."""
import ctypes
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys


def _decode(value):
    return re.sub(r'\\(040|011|012|134)',lambda match:chr(int(match[1],8)),value)


def plan(contents, root):
    """Validate a bounded kernel mount table and return deepest owned targets."""
    if type(contents) is not str or len(contents.encode())>1048576:
        raise ValueError('mount table bound')
    root=str(root)
    if not root.startswith('/') or str(PurePosixPath(root))!=root:
        raise ValueError('mount root invalid')
    rows=[]
    for line in contents.splitlines():
        fields=line.split(); separator=fields.index('-')
        if separator<6 or len(fields)!=separator+4:
            raise ValueError('mount record invalid')
        point=_decode(fields[4]); source=_decode(fields[3])
        if not point.startswith('/') or str(PurePosixPath(point))!=point or '..' in PurePosixPath(point).parts:
            raise ValueError('mount path invalid')
        rows.append({'id':int(fields[0]),'parent':int(fields[1]),'device':fields[2],
                     'source':source,'point':point,'type':fields[separator+1],
                     'shared':next((value[7:] for value in fields[6:separator] if value.startswith('shared:')),None)})
    if len({row['id'] for row in rows})!=len(rows):
        raise ValueError('duplicate mount id')
    enclosing=[row for row in rows if root==row['point'] or root.startswith(row['point'].rstrip('/')+'/')]
    if not enclosing:
        raise ValueError('root mount missing')
    base=max(enclosing,key=lambda row:len(row['point']))
    selected=[]
    for row in rows:
        if not any(row['point']==root+'/'+part or row['point'].startswith(root+'/'+part+'/') for part in ('data','exec')):
            continue
        relative=row['point'][len(root)+1:]
        expected_source=str(PurePosixPath(base['source']) / PurePosixPath(row['point']).relative_to(base['point']))
        data=(relative=='data' and row['device']==base['device'] and row['type']==base['type']
              and row['source']==expected_source)
        netns=(re.fullmatch(r'exec/netns/(?:[0-9a-f]{1,64}|default)',relative) is not None
               and row['type']=='nsfs' and re.fullmatch(r'net:\[[0-9]+\]',row['source']) is not None)
        if not (data or netns):
            raise ValueError('unknown owned mount class')
        if row['shared'] is not None and any(other['id']!=row['id'] and other['shared']==row['shared'] for other in rows):
            raise ValueError('shared mount peers present')
        selected.append(dict(row,relative=relative))
    if len(selected)>64 or len({row['point'] for row in selected})!=len(selected):
        raise ValueError('ambiguous owned mounts')
    return sorted(selected,key=lambda row:len(PurePosixPath(row['relative']).parts),reverse=True)


def _table():
    with open('/proc/self/mountinfo') as stream:
        return stream.read(1048577)


def _directory(parts, parent=None):
    descriptor=os.open('/',os.O_RDONLY|os.O_DIRECTORY) if parent is None else os.dup(parent)
    try:
        for part in parts:
            if part in ('','/','.','..'):
                raise ValueError('directory component invalid')
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=descriptor)
            os.close(descriptor);descriptor=child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _owner(root, token):
    if re.fullmatch(r'fleur-vfs-[0-9a-f]{32}',token) is None:
        raise ValueError('owner token invalid')
    root=Path(root)
    if not root.is_absolute() or '..' in root.parts:
        raise ValueError('owner root invalid')
    descriptor=_directory(root.parts[1:])
    try:
        identity=os.fstat(descriptor)
        if identity.st_mode & 0o077:
            raise ValueError('owner root permissions invalid')
        owner=os.open('owner',os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=descriptor)
        try:
            if not stat.S_ISREG(os.fstat(owner).st_mode) or os.read(owner,128)!=token.encode():
                raise ValueError('owner token mismatch')
        finally:
            os.close(owner)
        return descriptor,[identity.st_dev,identity.st_ino,identity.st_uid]
    except BaseException:
        os.close(descriptor)
        raise


def _unique_mount(descriptor):
    # Linux UAPI struct statx is 256 bytes; stx_mask is at 0 and stx_mnt_id
    # at 0x90. STATX_MNT_ID_UNIQUE avoids mountinfo's recyclable 32-bit IDs.
    library=ctypes.CDLL(None,use_errno=True)
    function=library.statx
    function.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_uint,ctypes.c_void_p]
    function.restype=ctypes.c_int
    result=ctypes.create_string_buffer(256)
    if function(descriptor,b'',0x1000,0x4000,result):  # AT_EMPTY_PATH
        raise OSError(ctypes.get_errno(),'unique mount inspection failed')
    mask=int.from_bytes(result.raw[:4],sys.byteorder)
    identity=int.from_bytes(result.raw[0x90:0x98],sys.byteorder)
    if not mask & 0x4000 or identity<=0:
        raise ValueError('unique mount identity unavailable')
    return identity


def _target(root_fd, relative):
    components=PurePosixPath(relative).parts
    parent=_directory(components[:-1],root_fd)
    try:
        target=os.open(components[-1],os.O_PATH|os.O_NOFOLLOW,dir_fd=parent)
        try:
            identity=os.fstat(target)
            with open('/proc/self/fdinfo/'+str(target)) as stream:
                rows=stream.read(4096).splitlines()
            ids=[int(row.split(':',1)[1]) for row in rows if row.startswith('mnt_id:')]
            if len(ids)!=1 or not (stat.S_ISREG(identity.st_mode) or stat.S_ISDIR(identity.st_mode)):
                raise ValueError('mount identity invalid')
            return parent,components[-1],[identity.st_dev,identity.st_ino,ids[0],_unique_mount(target)]
        finally:
            # Holding the target mount itself open would make ordinary unmount busy.
            os.close(target)
    except BaseException:
        os.close(parent)
        raise


def capture(root,token):
    root_fd,identity=_owner(root,token)
    try:
        mounts=plan(_table(),str(root))
        for row in mounts:
            parent,_,target=_target(root_fd,row['relative'])
            os.close(parent)
            if target[2]!=row['id']:
                raise ValueError('mount changed during capture')
            row['identity']=target
        return {'root':identity,'mounts':mounts}
    finally:
        os.close(root_fd)


def _unmount(parent,name):
    # The parent descriptor anchors all ancestor lookup. UMOUNT_NOFOLLOW rejects
    # a substituted final symlink; no MNT_FORCE or MNT_DETACH is permitted.
    library=ctypes.CDLL(None,use_errno=True)
    function=library.umount2;function.argtypes=[ctypes.c_char_p,ctypes.c_int];function.restype=ctypes.c_int
    if function(('/proc/self/fd/'+str(parent)+'/'+name).encode(),8):
        raise OSError(ctypes.get_errno(),'owned mount unmount failed')


def retire(root,token,expected):
    root_fd,identity=_owner(root,token)
    try:
        if type(expected) is not dict or set(expected)!={'root','mounts'} or identity!=expected['root']:
            raise ValueError('owned root changed')
        known={row['id']:row for row in expected['mounts']}
        current=plan(_table(),str(root))
        for row in current:
            saved=known.get(row['id'])
            if saved is None or row!={key:value for key,value in saved.items() if key!='identity'}:
                raise ValueError('owned mount changed')
        for row in current:
            parent,name,target=_target(root_fd,row['relative'])
            try:
                if target!=known[row['id']]['identity'] or row not in plan(_table(),str(root)):
                    raise ValueError('owned mount identity changed')
                _unmount(parent,name)
            finally:
                os.close(parent)
        if plan(_table(),str(root)):
            raise ValueError('owned mount remains')
        reopened,rechecked=_owner(root,token)
        os.close(reopened)
        if rechecked!=identity:
            raise ValueError('owned root changed during retirement')
        return len(current)
    finally:
        os.close(root_fd)


def native_self_test():
    """Exercise real kernel mounts in a disposable private mount namespace."""
    import errno
    import tempfile
    if sys.platform!='linux' or os.geteuid()!=0:
        raise ValueError('native mount prerequisite required')
    library=ctypes.CDLL(None,use_errno=True)
    if library.unshare(0x00020000):  # CLONE_NEWNS; never modify the host namespace.
        raise OSError(ctypes.get_errno(),'test namespace creation failed')
    mount=library.mount
    mount.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_ulong,ctypes.c_char_p]
    mount.restype=ctypes.c_int
    if mount(None,b'/',None,0x4000|0x40000,None):  # MS_REC | MS_PRIVATE
        raise OSError(ctypes.get_errno(),'test namespace isolation failed')
    with tempfile.TemporaryDirectory(prefix='fleur-mount-native-') as temporary:
        root=Path(temporary);token='fleur-vfs-'+'f'*32
        (root/'owner').write_text(token)
        for name in ('data','exec','unrelated'):(root/name).mkdir()
        (root/'unrelated/keep').write_text('preserve')
        (root/'exec/netns').mkdir();(root/'exec/netns/abc').touch()
        def bind(source,target):
            if mount(os.fsencode(source),os.fsencode(target),None,4096,None):
                raise OSError(ctypes.get_errno(),'test bind mount failed')
        def unmount_path(target):
            parent=os.open(target.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:_unmount(parent,target.name)
            finally:os.close(parent)
        def rejects(function):
            try:function()
            except (ValueError,OSError):return
            raise AssertionError('invalid cleanup accepted')
        bind(root/'unrelated',root/'unrelated')
        bind(root/'data',root/'data')
        bind('/proc/self/ns/net',root/'exec/netns/abc')
        try:
            expected=capture(root,token)
            if len(expected['mounts'])!=2:raise AssertionError('fixture mounts absent')
            # A live holder must produce EBUSY; retirement cannot detach lazily.
            holder=os.open(root/'data',os.O_RDONLY|os.O_DIRECTORY)
            try:
                try:retire(root,token,expected)
                except OSError as error:
                    if error.errno!=errno.EBUSY:raise
                else:raise AssertionError('busy mount accepted')
            finally:os.close(holder)
            if len(plan(_table(),str(root)))!=1:raise AssertionError('busy mount was detached')
            # Identity is captured before daemon retirement. A replacement bind
            # at the same path must remain mounted and make cleanup fail.
            unmount_path(root/'data');bind(root/'data',root/'data')
            rejects(lambda:retire(root,token,expected))
            current=capture(root,token)
            if len(current['mounts'])!=1:raise AssertionError('replacement mount removed')
            (root/'exec/unknown').mkdir();bind(root/'exec/unknown',root/'exec/unknown')
            try:rejects(lambda:retire(root,token,current))
            finally:unmount_path(root/'exec/unknown')
            if retire(root,token,current)!=1 or plan(_table(),str(root)):
                raise AssertionError('owned mount retirement incomplete')
            if not any(_decode(line.split()[4])==str(root/'unrelated') for line in _table().splitlines()):
                raise AssertionError('unrelated mount changed')
            remove_roots(root,token,current)
            if (root/'data').exists() or (root/'exec').exists():
                raise AssertionError('owned directories remain')
            (root/'data').symlink_to(root/'unrelated');(root/'exec').mkdir()
            rejects(lambda:remove_roots(root,token,current))
            (root/'data').unlink();(root/'data').mkdir()
            remove_roots(root,token,current)
            if (root/'unrelated/keep').read_text()!='preserve':
                raise AssertionError('unrelated contents changed')
            return {'ordinary_unmount_verified':True,'busy_mount_rejected':True,
                    'replacement_mount_rejected':True,'unknown_mount_rejected':True,
                    'unrelated_mount_preserved':True,'anchored_removal_verified':True,
                    'symlink_removal_rejected':True,'owned_mounts_remaining':0}
        finally:
            # Fixture-only cleanup is exact and ordinary. The private namespace
            # also prevents a failing test from leaving mounts in the host.
            for target in (root/'exec/netns/abc',root/'exec/unknown',root/'data',root/'unrelated'):
                if any(_decode(line.split()[4])==str(target) for line in _table().splitlines()):
                    unmount_path(target)


def remove_roots(root,token,expected):
    """Remove only owned trees through a pinned directory after zero-mount proof."""
    import shutil
    root_fd,identity=_owner(root,token)
    try:
        if type(expected) is not dict or identity!=expected.get('root') or plan(_table(),str(root)):
            raise ValueError('owned removal prerequisites changed')
        if not shutil.rmtree.avoids_symlink_attacks:
            raise ValueError('anchored removal unavailable')
        for name in ('data','exec'):
            try:shutil.rmtree(name,dir_fd=root_fd)
            except FileNotFoundError:pass
        for name in ('docker.sock','docker.pid','daemon.log','tasks.tmp','shim.tmp'):
            try:os.unlink(name,dir_fd=root_fd)
            except FileNotFoundError:pass
    finally:os.close(root_fd)
