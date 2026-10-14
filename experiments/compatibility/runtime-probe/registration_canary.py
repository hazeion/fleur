"""Trusted host-only event echo; no measured task starts before this proof."""
def register_canary(selector, subscriber, ctr, address, namespace, deadline, name, owner, forward, record_error):
    import json
    import os
    import selectors
    import signal
    import subprocess
    import time

    started=time.monotonic()
    count=0
    candidate=False
    confirmed=False
    cleaned=False
    children_reaped=True
    echo=False
    expected=None
    event_buffer=bytearray()
    cancelled=False
    category='canary-unverified'
    env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
         'CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS':'true'}
    # Reserve part of the existing allowance for ownership verification and
    # namespace retirement. This never extends the measured operation budget.
    work_limit=deadline-min(3,max(0,(deadline-started)/3))

    class Failed(Exception): pass

    def unique(pairs):
        result={}
        for key,value in pairs:
            if key in result: raise ValueError('duplicate key')
            result[key]=value
        return result

    def pump(limit, child=None, captured=None, cleanup=False):
        nonlocal echo,cancelled
        if time.monotonic()>=limit: raise Failed('canary-timeout')
        for key,_ in selector.select(min(.025,max(0,limit-time.monotonic()))):
            chunk=os.read(key.fileobj.fileno(),4096)
            if key.data=='control':
                selector.unregister(key.fileobj)
                cancelled=True
                if not cleanup: raise Failed('canary-cancelled')
            elif key.data in ('canary-out','canary-err'):
                if not chunk: selector.unregister(key.fileobj)
                else:
                    captured[key.data].extend(chunk)
                    if len(captured[key.data])>65536: raise Failed('canary-output-bound')
            elif key.data=='out':
                if not chunk: selector.unregister(key.fileobj)
                else:
                    forward(chunk)
                    event_buffer.extend(chunk)
                    if len(event_buffer)>65536: raise Failed('canary-event-bound')
                    while b'\n' in event_buffer:
                        line,_,tail=event_buffer.partition(b'\n')
                        event_buffer[:]=tail
                        if b' /namespaces/update ' not in line: continue
                        try:
                            prefix,body=line.split(b' /namespaces/update ',1)
                            value=json.loads(body,object_pairs_hook=unique)
                            if (prefix.endswith((' '+name).encode()) and expected is not None
                                    and value=={'name':name,'labels':{'fleur.observer.echo':expected}}):
                                echo=True
                        except (ValueError,UnicodeError): raise Failed('canary-event-invalid') from None
            elif key.data=='err':
                if not chunk: selector.unregister(key.fileobj)
                else: record_error(chunk)
                # Subscriber stderr remains private. Its exit is checked below.
        if not cleanup and (cancelled or subscriber.poll() is not None):
            raise Failed('canary-subscriber-ended')

    def call(arguments, limit, cleanup=False):
        nonlocal count,children_reaped
        if time.monotonic()>=limit: raise Failed('canary-timeout')
        child=None
        captured={'canary-out':bytearray(),'canary-err':bytearray()}
        try:
            count+=1
            child=subprocess.Popen([ctr,'--address',address,'--namespace',namespace]+arguments,
                stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                start_new_session=True,env=env)
            selector.register(child.stdout,selectors.EVENT_READ,'canary-out')
            selector.register(child.stderr,selectors.EVENT_READ,'canary-err')
            while child.poll() is None or any(key.data in captured for key in selector.get_map().values()):
                pump(limit,child,captured,cleanup)
            if child.returncode!=0: raise Failed('canary-command')
            return captured['canary-out'].decode('utf-8')
        finally:
            if child is not None:
                # The leader can exit while a descendant still holds a pipe.
                try: os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError: pass
                try:
                    child.wait(timeout=.2)
                except subprocess.TimeoutExpired:
                    children_reaped=False
                    raise
                finally:
                    for stream in (child.stdout,child.stderr):
                        try: selector.unregister(stream)
                        except KeyError: pass
                        stream.close()

    def owned(labels):
        for line in labels.splitlines():
            fields=line.split()
            if fields and fields[0]==name:
                if len(fields)!=2: raise Failed('canary-ownership')
                values=unique(item.split('=',1) for item in fields[1].split(','))
                if values.get('fleur.observer.owner')!=owner: raise Failed('canary-ownership')
                return True
        return False

    try:
        if name in call(['namespaces','list','--quiet'],work_limit).splitlines():
            raise Failed('canary-preexisting')
        candidate=True
        call(['namespaces','create',name,'fleur.observer.owner='+owner],work_limit)
        confirmed=True
        # Namespace label echoes form a bounded handshake. A missing echo is
        # never accepted, even if the publication command itself succeeds.
        sequence=0
        while not echo:
            sequence+=1
            expected=owner+'-'+str(sequence)
            call(['namespaces','label',name,'fleur.observer.echo='+expected],work_limit)
            echo_limit=min(work_limit,time.monotonic()+.05)
            while not echo and time.monotonic()<echo_limit:
                pump(echo_limit)
        category='verified'
    except (Failed,OSError,ValueError,subprocess.SubprocessError) as error:
        category=str(error) if isinstance(error,Failed) else 'canary-command'
    finally:
        if candidate:
            try:
                # Also handles create RPC uncertainty: never remove an object
                # whose freshly minted ownership label cannot be verified.
                exists=owned(call(['namespaces','list'],deadline,cleanup=True))
                if exists: call(['namespaces','remove',name],deadline,cleanup=True)
                elif confirmed: raise Failed('canary-ownership')
                cleaned=name not in call(['namespaces','list','--quiet'],deadline,cleanup=True).splitlines()
            except (Failed,OSError,ValueError,subprocess.SubprocessError):
                cleaned=False
        else:
            cleaned=True
    cleaned=cleaned and children_reaped
    passed=category=='verified' and echo and cleaned and time.monotonic()<deadline
    if not cleaned: category='canary-cleanup'
    return {'ready':passed,'cleanup_verified':cleaned,'category':category,
            'command_count':count,'duration_ms':round((time.monotonic()-started)*1000)}
