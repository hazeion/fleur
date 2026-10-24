"""Validate a source-authenticated, single native Docker-save OCI archive."""
import hashlib
import json
import re
import tarfile
import time
from typing import NamedTuple

class ImageIdentity(NamedTuple):
    config_image_id: str
    manifest_image_id: str
    manifest_bytes: int
    configuration: dict

BLOB=r'blobs/sha256/[a-f0-9]{64}'
MANIFEST='application/vnd.oci.image.manifest.v1+json'
LAYER='application/vnd.oci.image.layer.v1.tar'

def parse(body):
    def unique(rows):
        value=dict(rows)
        if len(value)!=len(rows):raise ValueError('duplicate OCI field')
        return value
    return json.loads(body,object_pairs_hook=unique)

def validate_archive(stream,image_id,deadline):
    if type(image_id) is not str or not re.fullmatch(r'sha256:[a-f0-9]{64}',image_id):raise ValueError('image identity invalid')
    def budget():
        if time.monotonic()>=deadline:raise ValueError('OCI validation deadline expired')
    budget();stream.seek(0);members={};small={};total=0
    try:
        with tarfile.open(fileobj=stream,mode='r:') as archive:
            for member in archive:
                budget();name=member.name
                if name in members or len(members)>=128:raise ValueError('OCI member inventory')
                if member.isdir() and name in ('blobs','blobs/sha256') and member.size==0:
                    members[name]=(0,None);continue
                if not member.isfile() or name not in ('index.json','manifest.json','oci-layout') and not re.fullmatch(BLOB,name):raise ValueError('OCI member path or kind')
                if not 0<member.size<=1073741824 or (not re.fullmatch(BLOB,name) and member.size>1048576):raise ValueError('OCI member bound')
                total+=member.size
                if total>1073741824:raise ValueError('OCI archive bound')
                body=archive.extractfile(member);digest=hashlib.sha256();data=bytearray();count=0
                while True:
                    budget();block=body.read(1048576)
                    if not block:break
                    count+=len(block);digest.update(block)
                    if member.size<=1048576:data.extend(block)
                if count!=member.size:raise ValueError('OCI short member')
                hashed=digest.hexdigest()
                if re.fullmatch(BLOB,name) and name.rsplit('/',1)[1]!=hashed:raise ValueError('OCI blob digest')
                members[name]=(count,hashed)
                if member.size<=1048576:small[name]=bytes(data)
        def document(name):
            if name not in small:raise ValueError('OCI document unavailable')
            return parse(small[name])
        if document('oci-layout')!={'imageLayoutVersion':'1.0.0'}:raise ValueError('OCI layout')
        legacy=document('manifest.json');index=document('index.json')
        if type(legacy) is not list or len(legacy)!=1 or type(legacy[0]) is not dict or set(legacy[0]) not in ({'Config','RepoTags','Layers'},{'Config','RepoTags','Layers','LayerSources'}):raise ValueError('single image required')
        saved=legacy[0];config_path='blobs/sha256/'+image_id[7:]
        if saved['Config']!=config_path or saved['RepoTags'] is not None or type(saved['Layers']) is not list or not 1<=len(saved['Layers'])<=32 or len(set(saved['Layers']))!=len(saved['Layers']):raise ValueError('OCI image or tag binding')
        if type(index) is not dict or set(index)!={'schemaVersion','mediaType','manifests'} or type(index['schemaVersion']) is not int or index['schemaVersion']!=2 or index['mediaType']!='application/vnd.oci.image.index.v1+json' or type(index['manifests']) is not list or len(index['manifests'])!=1:raise ValueError('single OCI index required')
        def descriptor(value,media):
            if type(value) is not dict or set(value)!={'mediaType','digest','size'} or value['mediaType']!=media or type(value['digest']) is not str or not re.fullmatch(r'sha256:[a-f0-9]{64}',value['digest']) or type(value['size']) is not int:raise ValueError('OCI descriptor')
            path='blobs/sha256/'+value['digest'][7:]
            if path not in members or members[path]!=(value['size'],value['digest'][7:]):raise ValueError('OCI descriptor bytes')
            return path
        root=document(descriptor(index['manifests'][0],MANIFEST))
        if type(root) is not dict or set(root)!={'schemaVersion','mediaType','config','layers'} or type(root['schemaVersion']) is not int or root['schemaVersion']!=2 or root['mediaType']!=MANIFEST:raise ValueError('OCI root manifest')
        if descriptor(root['config'],'application/vnd.oci.image.config.v1+json')!=config_path:raise ValueError('OCI config binding')
        if type(root['layers']) is not list or [descriptor(x,LAYER) for x in root['layers']]!=saved['Layers']:raise ValueError('OCI layer binding')
        if 'LayerSources' in saved:
            expected={x['digest']:x for x in root['layers']}
            if saved['LayerSources']!=expected:raise ValueError('Docker layer sources differ')
        config=document(config_path)
        if config.get('architecture')!='amd64' or config.get('os')!='linux' or config.get('rootfs')!={'type':'layers','diff_ids':['sha256:'+x.rsplit('/',1)[1] for x in saved['Layers']]}:raise ValueError('native image or layer diff binding')
        if type(config.get('config')) is not dict or config['config'].get('Volumes') not in (None,{}):raise ValueError('image declares volumes')
        budget();return ImageIdentity(image_id,index['manifests'][0]['digest'],index['manifests'][0]['size'],config)
    except (KeyError,TypeError,AttributeError,tarfile.TarError) as error:raise ValueError('OCI archive invalid') from error
    finally:stream.seek(0)
