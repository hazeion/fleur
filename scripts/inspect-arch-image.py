"""Fixed authenticated Arch image header precheck. Does not replace qemu-img check."""
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import sys
import time

PIN_SHA256 = '360f0fa49db6813bdc8e35bed230a2dc2ae3567b7b5ab74719c0a706e4e34e87'
PIN_BYTES = 578080256
PREFIX_SHA256 = '832e89fe53a4bf672fd28546ef170ecf874244b8314d1b3df3611a49ffa84a8d'
HEADER = (b'QFI\xfb',3,0,0,16,2147483648,0,4,196608,65536,1,0,0,0,0,0,4,112)


def validate_header(prefix, size):
    if type(prefix) is not bytes or len(prefix) != 65536 or type(size) is not int or size != PIN_BYTES:
        raise ValueError('Fixed Arch image size or bounded header differs')
    fields = struct.unpack('>4sIQIIQIIQQIIQQQQII',prefix[:104])
    if fields != HEADER or prefix[104:112] != bytes(8):
        raise ValueError('Fixed Arch image header layout differs')
    kind, length = struct.unpack('>II',prefix[112:120])
    if (kind != 0x6803f857 or length != 384
            or hashlib.sha256(prefix[120:504]).hexdigest() != 'c48c50722126cae8a87bd804a27fa48655be3ea3c4dc2a3d92971c25c381a1b3'
            or prefix[504:] != bytes(65536-504)
            or hashlib.sha256(prefix[:512]).hexdigest() != PREFIX_SHA256):
        raise ValueError('Fixed Arch image extensions or padding differ')
    return {'headerPrecheck':True,'fullStructureValidated':False,'imageAuthenticated':False,
            'virtualBytes':2147483648,'backingFile':False,'externalData':False,
            'encrypted':False,'snapshots':False,'headerPrefixSha256':PREFIX_SHA256}


def identity(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,
            info.st_size,info.st_mtime_ns,info.st_ctime_ns)


def inspect(path):
    # Only a private source-owned staged input is accepted. The pathname is never
    # passed to an image interpreter until this full-byte check succeeds.
    parent = os.open(str(path.parent),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK)
    fd = None
    try:
        held = os.fstat(parent)
        if held.st_uid != os.getuid() or held.st_mode & 0o077:
            raise ValueError('Private image parent unavailable')
        fd = os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                or before.st_nlink != 1 or before.st_mode & 0o022 or before.st_size != PIN_BYTES):
            raise ValueError('Staged image custody differs')
        digest = hashlib.sha256(); prefix = bytearray(); count = 0
        deadline = time.monotonic()+30
        while count < PIN_BYTES:
            if time.monotonic() >= deadline:
                raise ValueError('Image authentication deadline expired')
            chunk = os.read(fd,min(1024*1024,PIN_BYTES-count))
            if not chunk:
                raise ValueError('Image ended before authenticated length')
            if len(prefix)<65536:
                prefix.extend(chunk[:65536-len(prefix)])
            digest.update(chunk); count += len(chunk)
        if (os.read(fd,1) or time.monotonic() >= deadline or digest.hexdigest()!=PIN_SHA256
                or identity(before)!=identity(os.fstat(fd))
                or identity(before)!=identity(os.stat(path.name,dir_fd=parent,follow_symlinks=False))
                or identity(held)!=identity(os.fstat(parent))
                or identity(held)!=identity(path.parent.lstat())):
            raise ValueError('Staged image bytes or custody changed')
        result=validate_header(bytes(prefix),count)
        return {**result,'imageAuthenticated':True,'sha256':PIN_SHA256,'bytes':count}
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


if __name__ == '__main__':
    report={'formatVersion':1,'scope':'fixed-arch-image-precheck','ok':False,
            'installationVerified':False,'nativeQualification':False,'runtimeAdmission':False}
    try:
        if len(sys.argv)!=3 or sys.argv[1]!='--image' or not Path(sys.argv[2]).is_absolute():
            raise ValueError('Use --image with a private staged fixed image')
        report.update(inspect(Path(sys.argv[2])));report['ok']=True
    except (OSError,ValueError) as error:
        report['error']={'type':type(error).__name__,'message':str(error)}
    print(json.dumps(report))
    raise SystemExit(0 if report['ok'] else 4)
