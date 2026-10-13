"""Accept complete typed evidence and confirmed cleanup, never the v1 gate."""
AMD64_CONTROLS = ['openat', 'open', 'unlinkat', 'socket', 'connect', 'execve',
                  'unshare', 'ptrace', 'setuid', 'io_uring_setup', 'openat2', 'creat',
                  'rename', 'socketpair', 'clone', 'clone3', 'setns', 'process_vm_readv',
                  'capset', 'io_uring_enter', 'io_uring_register', 'file_mmap', 'dup', 'x32_openat']
ARM64_CONTROLS = list(AMD64_CONTROLS)
ARM64_CONTROLS[1] = 'openat_write'
ARM64_CONTROLS[11] = 'openat_create'
ARM64_CONTROLS[12] = 'renameat2'
ARM64_CONTROLS[23] = 'unknown_syscall'
CONTROLS = {'amd64': AMD64_CONTROLS, 'arm64': ARM64_CONTROLS}


def accept(report, expected_architecture=None):
    if not isinstance(report, dict):
        return False
    architecture = report.get('architecture')
    if type(architecture) is not str or architecture not in CONTROLS or (expected_architecture is not None and architecture != expected_architecture):
        return False
    if report.get('negative_controls') != CONTROLS[architecture]:
        return False
    install = report.get('install')
    main = report.get('main')
    thread = report.get('thread')
    return (type(install) is int and install == 0
            and type(report.get('html')) is str
            and report['html'] == '<p>restricted render</p>'
            and type(main) is list and len(main) == 24
            and all(type(item) is int and item == -1 for item in main)
            and type(thread) is int and thread == -1
            and report.get('application_open') is True
            and report.get('cgroups') == {'cpu':'100000 100000', 'memory':'536870912', 'pids':'64'}
            and report.get('descriptors_closed') is True
            and report.get('broker_reply') == 'registered:Squat'
            and report.get('cleanup_complete') is True)
