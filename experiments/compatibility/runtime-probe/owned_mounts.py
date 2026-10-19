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
                     'shared':next((value[7:] for value in fields[6:separator] if value.startswith('shared:')),None),
                     'master':next((value[7:] for value in fields[6:separator] if value.startswith('master:')),None)})
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
        parent=next((other for other in rows if other['id']==row['parent']),None)
        # Unmount propagates through the PARENT's peer/slave receiver closure,
        # including receivers in other mount namespaces absent from mountinfo.
        # A private or slave-only parent cannot send that propagation. A shared
        # parent is unprovable here; reject rather than changing host propagation.
        if parent is None or parent['shared'] is not None:
            raise ValueError('owned unmount propagation unconfined')
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


CAPTURE_PHASES=('owner','root-identity','mount-table','mount-plan','mount-target')
CAPTURE_CATEGORIES=('filesystem','owner','mount-class','shared-parent','shared-peers',
                    'unique-id','mount-identity','validation','unsupported','unexpected')
LAYOUT_COUNTS=('owned','data_root','exec_root','network_namespace','nested_data','nested_exec',
               'shared_parent','unknown_parent','shared_mount','slave_mount',
               'fs_ext4','fs_xfs','fs_btrfs','fs_overlay','fs_tmpfs','fs_nsfs','fs_other')


def capture_layout(contents,root):
    """Only bounded classifications leave the private mount-table boundary."""
    counts={key:0 for key in LAYOUT_COUNTS}
    if type(contents) is not str or len(contents.encode())>1048576:
        raise ValueError('mount table bound')
    rows=[];root=str(root)
    for line in contents.splitlines():
        fields=line.split();separator=fields.index('-')
        if separator<6 or len(fields)!=separator+4:
            raise ValueError('mount row invalid')
        rows.append((int(fields[0]),int(fields[1]),_decode(fields[4]),fields[separator+1],
                     any(part.startswith('shared:') for part in fields[6:separator]),
                     any(part.startswith('master:') for part in fields[6:separator])))
    parents={row[0]:row for row in rows}
    for _,parent,point,filesystem,shared,slave in rows:
        if not any(point==root+'/'+part or point.startswith(root+'/'+part+'/') for part in ('data','exec')):
            continue
        relative=point[len(root)+1:];counts['owned']+=1
        if relative=='data':kind='data_root'
        elif relative=='exec':kind='exec_root'
        elif relative.startswith('exec/netns/'):kind='network_namespace'
        elif relative.startswith('data/'):kind='nested_data'
        else:kind='nested_exec'
        counts[kind]+=1
        counts['fs_'+(filesystem if filesystem in ('ext4','xfs','btrfs','overlay','tmpfs','nsfs') else 'other')]+=1
        counts['shared_mount']+=int(shared);counts['slave_mount']+=int(slave)
        counts['unknown_parent']+=int(parent not in parents)
        counts['shared_parent']+=int(parent in parents and parents[parent][4])
    return {key:min(value,65) for key,value in counts.items()}


def capture_cli(root,token,expected_root):
    diagnostics={'phase':'owner'}
    try:
        result=capture(root,token,expected_root,diagnostics)
    except Exception as error:
        category={
            'owner token mismatch':'owner','owner root permissions invalid':'owner',
            'initial owned root changed':'owner','unknown owned mount class':'mount-class',
            'owned unmount propagation unconfined':'shared-parent','shared mount peers present':'shared-peers',
            'unique mount identity unavailable':'unique-id','mount identity invalid':'mount-identity',
            'mount changed during capture':'mount-identity',
        }.get(str(error),'validation' if isinstance(error,ValueError) else 'unexpected')
        if isinstance(error,OSError):
            category='filesystem'
            if type(error.errno) is int and 0<=error.errno<=4095:diagnostics['errno']=error.errno
        elif isinstance(error,AttributeError):category='unsupported'
        diagnostics['category']=category
        print(json.dumps({'capture_error':diagnostics},separators=(',',':'),sort_keys=True))
        return 1
    print(json.dumps(result,separators=(',',':')))
    return 0


def capture(root,token,expected_root=None,diagnostics=None):
    diagnostics={} if diagnostics is None else diagnostics
    diagnostics['phase']='owner'
    root_fd,identity=_owner(root,token)
    try:
        diagnostics['phase']='root-identity'
        if expected_root is not None and identity!=expected_root:
            raise ValueError('initial owned root changed')
        diagnostics['phase']='mount-table'
        contents=_table()
        try:diagnostics['layout']=capture_layout(contents,root)
        except (ValueError,IndexError):diagnostics['layout_invalid']=True
        diagnostics['phase']='mount-plan'
        mounts=plan(contents,str(root))
        diagnostics['phase']='mount-target'
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
    propagation_verified=native_propagation_test()
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
                    'symlink_removal_rejected':True,'shared_parent_slave_rejected':propagation_verified,
                    'owned_mounts_remaining':0}
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


def native_propagation_test():
    """Reject shared-parent/slave cleanup in a new private test mount namespace."""
    import tempfile
    if sys.platform!='linux' or os.geteuid()!=0:
        raise ValueError('native mount prerequisite required')
    library=ctypes.CDLL(None,use_errno=True)
    # Establish this boundary here even when called independently of the other
    # native fixture. No propagation change occurs in the caller's namespace.
    if library.unshare(0x00020000):  # CLONE_NEWNS
        raise OSError(ctypes.get_errno(),'propagation test namespace creation failed')
    mount=library.mount
    mount.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_ulong,ctypes.c_char_p]
    mount.restype=ctypes.c_int
    if mount(None,b'/',None,0x4000|0x40000,None):  # MS_REC | MS_PRIVATE
        raise OSError(ctypes.get_errno(),'propagation test namespace isolation failed')
    with tempfile.TemporaryDirectory(prefix='fleur-propagation-native-') as temporary:
        base=Path(temporary);parent=base/'parent';alias=base/'alias'
        parent.mkdir();alias.mkdir()
        root=parent/'owned';outside=alias/'owned/exec/netns/abc'
        def change(source,target,flags):
            if mount(None if source is None else os.fsencode(source),os.fsencode(target),None,flags,None):
                raise OSError(ctypes.get_errno(),'test propagation setup failed')
        def ids():
            return {_decode(fields[4]):int(fields[0]) for fields in (line.split() for line in _table().splitlines())}
        def cleanup(target):
            if str(target) not in ids():return
            descriptor=os.open(target.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:_unmount(descriptor,target.name)
            finally:os.close(descriptor)
        change(parent,parent,4096)
        try:
            change(None,parent,0x100000)  # MS_SHARED inside private test namespace.
            change(parent,alias,4096)
            change(None,alias,0x80000)  # MS_SLAVE; receives parent propagation.
            root.mkdir(mode=0o700);(root/'data').mkdir();(root/'exec/netns').mkdir(parents=True)
            token='fleur-vfs-'+'e'*32;(root/'owner').write_text(token)
            target=root/'exec/netns/abc';target.touch()
            change('/proc/self/ns/net',target,4096)
            before=ids()
            if str(target) not in before or str(outside) not in before:
                raise AssertionError('slave mount propagation premise absent')
            try:capture(root,token)
            except ValueError:pass
            else:raise AssertionError('external propagation accepted')
            after=ids()
            if any(after.get(str(path))!=before[str(path)] for path in (target,outside)):
                raise AssertionError('rejected propagation changed mounts')
        finally:
            # Every target below is a fresh fixture in this private namespace.
            cleanup(outside);cleanup(root/'exec/netns/abc');cleanup(alias);cleanup(parent)
    return True
