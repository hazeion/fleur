"""Read source-pinned Desktop preparation bytes through retained descriptors."""
from dataclasses import dataclass
import hashlib
import json
import math
import time
import os
from pathlib import Path
import re
import stat

FILES={'controller-image.tar','runtime-image.tar','runtime-preparation.json','source-manifest.json','controller-packages.tsv','controller-tools.json','preparation-cleanup.json'}
IMAGES={'controller-image.tar','runtime-image.tar'}
HEX=r'[a-f0-9]{64}'

def canonical_json(body):
    def unique(pairs):
        value=dict(pairs)
        if len(value)!=len(pairs):raise ValueError('duplicate JSON field')
        return value
    return json.loads(body,object_pairs_hook=unique)

def valid_catalog(value):
    try:
        if type(value) is not dict or set(value)!={'formatVersion','scope','runtimeAdmission','producer','origin'} or type(value['formatVersion']) is not int or value['formatVersion']!=1 or value['scope']!='source-owned-desktop-preparation-inputs' or value['runtimeAdmission'] is not False:return False
        producer=value['producer'];origin=value['origin']
        if type(producer) is not dict or set(producer)!={'workflowRunId','artifactId','zipSha256','imageOriginSha256'}:return False
        if any(type(producer[key]) is not int or producer[key]<=0 for key in ('workflowRunId','artifactId')):return False
        if any(type(producer[key]) is not str or not re.fullmatch(HEX,producer[key]) for key in ('zipSha256','imageOriginSha256')):return False
        if type(origin) is not dict or set(origin)!={'formatVersion','scope','runtimeAdmission','nativeQualification','sourceCommit','controllerImageId','artifacts','cleanup','ok'}:return False
        if type(origin['formatVersion']) is not int or origin['formatVersion']!=1 or origin['scope']!='desktop-qualification-image-preparation' or origin['runtimeAdmission'] is not False or origin['nativeQualification'] is not False or origin['ok'] is not True:return False
        if type(origin['sourceCommit']) is not str or not re.fullmatch('[a-f0-9]{40}',origin['sourceCommit']) or type(origin['controllerImageId']) is not str or not re.fullmatch('sha256:'+HEX,origin['controllerImageId']):return False
        if origin['cleanup']!=[{'resource':'container','absent':True},{'resource':'image','absent':True}]:return False
        if any(type(row['absent']) is not bool for row in origin['cleanup']):return False
        pins=origin['artifacts']
        if type(pins) is not dict or set(pins)!=FILES:return False
        for name,pin in pins.items():
            if type(pin) is not dict or set(pin)!={'bytes','sha256'} or type(pin['bytes']) is not int or not 0<pin['bytes']<=(1073741824 if name in IMAGES else 1048576) or type(pin['sha256']) is not str or not re.fullmatch(HEX,pin['sha256']):return False
        return True
    except (KeyError,TypeError,AttributeError):return False

def identity(value):return (value.st_dev,value.st_ino,value.st_mode,value.st_uid,value.st_nlink,value.st_size,value.st_mtime_ns,value.st_ctime_ns)

def digest_fd(fd,expected_bytes,deadline):
    os.lseek(fd,0,os.SEEK_SET);digest=hashlib.sha256();count=0
    while count<=expected_bytes:
        if time.monotonic()>=deadline:raise ValueError('artifact deadline expired')
        block=os.read(fd,min(1048576,expected_bytes+1-count))
        if time.monotonic()>=deadline:raise ValueError('artifact deadline expired')
        if not block:break
        count+=len(block);digest.update(block)
    if count!=expected_bytes:raise ValueError('artifact byte count changed')
    os.lseek(fd,0,os.SEEK_SET)
    return digest.hexdigest()

@dataclass
class RetainedArtifacts:
    directory: int
    descriptors: dict
    pins: dict
    original: dict
    catalog: dict
    directory_identity: tuple
    deadline: float

    def verify(self,name):
        if time.monotonic()>=self.deadline:raise ValueError('artifact deadline expired')
        if identity(os.fstat(self.directory))!=self.directory_identity:raise ValueError('artifact directory changed')
        fd=self.descriptors[name];before=self.original[name]
        current=os.stat(name,dir_fd=self.directory,follow_symlinks=False)
        if identity(os.fstat(fd))!=before or identity(current)!=before or digest_fd(fd,self.pins[name]['bytes'],self.deadline)!=self.pins[name]['sha256'] or identity(os.fstat(fd))!=before or identity(os.stat(name,dir_fd=self.directory,follow_symlinks=False))!=before:raise ValueError('retained artifact changed')
        return fd

    def read_json(self,name):
        fd=self.verify(name);data=bytearray();size=self.pins[name]['bytes']
        while len(data)<=size:
            if time.monotonic()>=self.deadline:raise ValueError('artifact deadline expired')
            block=os.read(fd,min(65536,size+1-len(data)))
            if time.monotonic()>=self.deadline:raise ValueError('artifact deadline expired')
            if not block:break
            data.extend(block)
        os.lseek(fd,0,os.SEEK_SET)
        if len(data)!=size or hashlib.sha256(data).hexdigest()!=self.pins[name]['sha256'] or identity(os.fstat(fd))!=self.original[name] or identity(os.stat(name,dir_fd=self.directory,follow_symlinks=False))!=self.original[name] or identity(os.fstat(self.directory))!=self.directory_identity:raise ValueError('JSON read bytes changed')
        return canonical_json(data)

    def close(self):
        for fd in self.descriptors.values():os.close(fd)
        self.descriptors.clear();os.close(self.directory)

    def __enter__(self):return self
    def __exit__(self,*args):self.close()

def open_artifacts(path,catalog,absolute_deadline=None):
    deadline=time.monotonic()+120 if absolute_deadline is None else absolute_deadline
    if type(deadline) not in (int,float) or not math.isfinite(deadline) or time.monotonic()>=deadline:raise ValueError('artifact deadline expired')
    if not valid_catalog(catalog):raise ValueError('source-owned artifact catalog invalid')
    directory=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK)
    descriptors={}
    try:
        info=os.fstat(directory)
        if info.st_uid!=os.getuid() or info.st_mode&0o7777!=0o700 or not stat.S_ISDIR(info.st_mode):raise ValueError('private artifact directory required')
        if set(os.listdir(directory))!=FILES|{'image-origin.json'}:raise ValueError('closed artifact inventory required')
        pins={**catalog['origin']['artifacts'],'image-origin.json':{'bytes':os.stat('image-origin.json',dir_fd=directory,follow_symlinks=False).st_size,'sha256':catalog['producer']['imageOriginSha256']}}
        if not 0<pins['image-origin.json']['bytes']<=1048576:raise ValueError('origin bound')
        originals={}
        for name,pin in pins.items():
            if time.monotonic()>=deadline:raise ValueError('artifact deadline expired')
            fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory);descriptors[name]=fd
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_uid!=os.getuid() or before.st_nlink!=1 or before.st_size!=pin['bytes'] or before.st_mode&0o7777!=0o600:raise ValueError('private owned regular artifact required')
            originals[name]=identity(before)
        result=RetainedArtifacts(directory,descriptors,pins,originals,catalog,identity(info),deadline)
        for name in pins:result.verify(name)
        parsed=result.read_json('image-origin.json')
        if not valid_catalog({**catalog,'origin':parsed}) or parsed!=catalog['origin']:raise ValueError('origin differs from source catalog')
        cleanup=result.read_json('preparation-cleanup.json')
        if type(cleanup) is not dict or set(cleanup)!={'formatVersion','scope','cleanup','ok','runtimeAdmission','nativeQualification'} or type(cleanup['formatVersion']) is not int or cleanup['formatVersion']!=1 or cleanup['scope']!='disposable-image-preparation-retirement' or cleanup['ok'] is not True or cleanup['runtimeAdmission'] is not False or cleanup['nativeQualification'] is not False or cleanup['cleanup']!=catalog['origin']['cleanup'] or any(type(row.get('absent')) is not bool for row in cleanup['cleanup']):raise ValueError('producer cleanup unconfirmed')
        return result
    except BaseException:
        for fd in descriptors.values():os.close(fd)
        os.close(directory);raise
