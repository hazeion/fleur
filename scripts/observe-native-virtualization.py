"""Bounded read-only runner observations. No VM creation or platform admission."""
import json
import os
import platform
import stat
import subprocess
import sys


def device_observation():
    # Only this child opens the fixed device. Its parent enforces a five-second
    # observation bound; no KVM_CREATE_VM or other state-changing ioctl is used.
    import fcntl
    result = {'apiVersion': None, 'device': 'unknown'}
    fd = None
    try:
        before = os.lstat('/dev/kvm')
        if not stat.S_ISCHR(before.st_mode):
            raise ValueError('Unexpected device type')
        fd = os.open('/dev/kvm', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        fields = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid, value.st_rdev)
        if fields(os.fstat(fd)) != fields(before):
            raise ValueError('Device identity changed')
        version = fcntl.ioctl(fd, 0xAE00, 0)  # Linux KVM_GET_API_VERSION, read only.
        if fields(os.fstat(fd)) != fields(before) or fields(os.lstat('/dev/kvm')) != fields(before):
            raise ValueError('Device identity changed')
        result = {'apiVersion': version, 'device': 'observed', 'characterDevice': True}
    except FileNotFoundError:
        result['device'] = 'absent'
    except PermissionError:
        result['device'] = 'permission-denied'
    except Exception as error:
        result['error'] = type(error).__name__
    finally:
        if fd is not None:
            os.close(fd)
    print(json.dumps(result))


def main():
    result = {'formatVersion': 1, 'scope': 'native-runner-virtualization-observation',
              'system': platform.system(), 'architecture': platform.machine(),
              'kernel': platform.release(), 'effectiveRoot': os.geteuid() == 0,
              'nativeQualification': False, 'vmCreated': False,
              'kvmUsable': 'unproven'}
    if platform.system() != 'Linux':
        result['kvm'] = {'device': 'not-applicable'}
    else:
        try:
            observed = subprocess.run([sys.executable, '-I', __file__, '--fixed-device-child'],
                                      stdin=subprocess.DEVNULL, capture_output=True,
                                      timeout=5, check=True)
            if len(observed.stdout) > 4096 or observed.stderr:
                raise ValueError('Unexpected device observation output')
            result['kvm'] = json.loads(observed.stdout)
        except Exception as error:
            result['kvm'] = {'device': 'unknown', 'error': type(error).__name__}
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    if sys.argv[1:] == ['--fixed-device-child']:
        device_observation()
    elif not sys.argv[1:]:
        main()
    else:
        raise SystemExit('No caller-selected device or operation is supported')
