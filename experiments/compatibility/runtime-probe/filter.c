#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <stdatomic.h>
#include <pthread.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>

/* One pre-existing native thread is a witness for TSYNC propagation. */
static pthread_t witness;
static _Atomic int phase;
static _Atomic int thread_result;
static void *observe(void *unused) {
    (void)unused;
    atomic_store(&phase, 1);
    while (atomic_load(&phase) != 2) syscall(SYS_sched_yield);
    long result = syscall(SYS_openat, AT_FDCWD, "/etc/passwd", O_RDONLY, 0);
    atomic_store(&thread_result, result == -1 && errno == EPERM ? -1 : 0);
    atomic_store(&phase, 3);
    return NULL;
}
int prepare(void) {
    int readable = open("/etc/passwd", O_RDONLY);
    if (readable < 0) return -1;
    close(readable);
    if (pthread_create(&witness, NULL, observe, NULL)) return -1;
    while (atomic_load(&phase) != 1) syscall(SYS_sched_yield);
    return 0;
}
#define ALLOW(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_##n, 0, 1), BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW)
int install(void) {
#if !defined(__x86_64__)
    return -1;
#else
    /* Deny-by-default also rejects openat2, io_uring, clone3 and x32 numbers. */
    struct sock_filter code[] = {
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
        ALLOW(brk), ALLOW(mmap), ALLOW(munmap), ALLOW(mprotect), ALLOW(madvise),
        ALLOW(mremap), ALLOW(futex), ALLOW(sched_yield), ALLOW(sched_getaffinity),
        ALLOW(clock_gettime), ALLOW(clock_nanosleep), ALLOW(nanosleep),
        ALLOW(getpid), ALLOW(gettid), ALLOW(getrandom), ALLOW(rt_sigaction),
        ALLOW(rt_sigprocmask), ALLOW(rt_sigreturn), ALLOW(sigaltstack),
        ALLOW(exit), ALLOW(exit_group), ALLOW(close), ALLOW(restart_syscall),
        /* Output is restricted to inherited stdout/stderr. Input to stdin. */
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_read, 0, 4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 0, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_write, 1, 0),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_writev, 0, 4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 1, 1, 0),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 2, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
    };
    struct sock_fprog program = {sizeof(code)/sizeof(code[0]), code};
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return -1;
    /* Nonzero includes a positive unsynchronizable TID. Never accept it. */
    long result = syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER,
                          SECCOMP_FILTER_FLAG_TSYNC, &program);
    return result == 0 ? 0 : -1;
#endif
}
int check_thread(void) {
    atomic_store(&phase, 2);
    while (atomic_load(&phase) != 3) syscall(SYS_sched_yield);
    return atomic_load(&thread_result);
}
int negative(int choice) {
    errno = 0;
    long result;
    switch (choice) {
        case 0: result = syscall(SYS_openat, AT_FDCWD, "/etc/passwd", O_RDONLY, 0); break;
        case 1: result = syscall(SYS_open, "/etc/passwd", O_RDONLY, 0); break;
        case 2: result = syscall(SYS_unlinkat, AT_FDCWD, "/tmp/target", 0); break;
        case 3: result = syscall(SYS_socket, AF_INET, SOCK_STREAM, 0); break;
        case 4: result = syscall(SYS_connect, -1, NULL, 0); break;
        case 5: result = syscall(SYS_execve, "/bin/true", NULL, NULL); break;
        case 6: result = syscall(SYS_unshare, 0); break;
        case 7: result = syscall(SYS_ptrace, 0, 0, NULL, NULL); break;
        case 8: result = syscall(SYS_setuid, 0); break;
        case 9: result = syscall(SYS_io_uring_setup, 1, NULL); break;
        default: return 0;
    }
    return result == -1 && errno == EPERM ? -1 : 0;
}
