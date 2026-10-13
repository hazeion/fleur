#define _GNU_SOURCE
#include <stdio.h>
#include <errno.h>
#include <dirent.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
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

/* Only native 64-bit little-endian syscall ABIs are admitted. */
#if defined(__x86_64__) && !defined(__ILP32__)
#define PROBE_AUDIT_ARCH AUDIT_ARCH_X86_64
#define PROBE_ARCHITECTURE 1
#elif defined(__aarch64__) && !defined(__ILP32__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#define PROBE_AUDIT_ARCH AUDIT_ARCH_AARCH64
#define PROBE_ARCHITECTURE 2
#else
#error "unsupported native syscall ABI"
#endif
int architecture(void) { return PROBE_ARCHITECTURE; }
/* One pre-existing native thread is a witness for TSYNC propagation. */
static pthread_t witness;
static int unrelated_fd;
static int closed_unrelated;
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
    unrelated_fd = readable;
    if (pthread_create(&witness, NULL, observe, NULL)) return -1;
    while (atomic_load(&phase) != 1) syscall(SYS_sched_yield);
    return 0;
}
/* Trusted descriptor admission: only stdio and kernel event bookkeeping.
 * Opening, mapping, duplicating or transferring descriptors is later denied. */
int close_unrelated(void) {
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) return -1;
    int directory_fd = dirfd(directory);
    struct dirent *entry;
    while ((entry = readdir(directory))) {
        char *end;
        long descriptor = strtol(entry->d_name, &end, 10);
        if (*end || descriptor <= 2 || descriptor == directory_fd) continue;
        char path[64], target[256];
        int length = snprintf(path, sizeof(path), "/proc/self/fd/%ld", descriptor);
        if (length < 0 || (size_t)length >= sizeof(path)) { closedir(directory); return -1; }
        ssize_t size = readlink(path, target, sizeof(target) - 1);
        if (size < 0) { closedir(directory); return -1; }
        target[size] = 0;
        if (!strcmp(target, "anon_inode:[eventpoll]") ||
            !strcmp(target, "anon_inode:[eventfd]") ||
            !strcmp(target, "anon_inode:[timerfd]")) continue;
        if (close((int)descriptor)) { closedir(directory); return -1; }
    }
    if (closedir(directory)) return -1;
    errno = 0;
    closed_unrelated = fcntl(unrelated_fd, F_GETFD) == -1 && errno == EBADF;
    return closed_unrelated ? 0 : -1;
}
int descriptors_closed(void) { return closed_unrelated; }
/* Synchronous bounded stdio transport. Trusted host validates the request. */
int broker_exchange(void) {
    const char request[] = "{\"kind\":\"broker-request\",\"operation\":\"compat.query\",\"token\":\"probe-query\",\"action\":\"readExercise\",\"input\":{\"id\":1}}\n";
    size_t sent = 0;
    while (sent < sizeof(request)-1) {
        ssize_t count = write(1, request+sent, sizeof(request)-1-sent);
        if (count <= 0) return -1;
        sent += (size_t)count;
    }
    char reply[4096]; size_t used = 0;
    while (used < sizeof(reply)-1) {
        ssize_t count = read(0, reply+used, 1);
        if (count != 1) return -1;
        if (reply[used++] == '\n') break;
    }
    reply[used] = 0;
    return !strcmp(reply, "registered:Squat\n") ? 0 : -1;
}
#define ALLOW(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_##n, 0, 1), BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW)
int install(void) {
    /* Deny-by-default also rejects openat2, io_uring, clone3 and x32 numbers. */
    struct sock_filter code[] = {
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, PROBE_AUDIT_ARCH, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
        ALLOW(brk),
        /* Anonymous memory only: retained event descriptors cannot map files. */
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_mmap, 0, 4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[3])),
        BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, MAP_ANONYMOUS, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        ALLOW(munmap), ALLOW(mprotect), ALLOW(madvise),
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
#if defined(__x86_64__)
        case 1: result = syscall(SYS_open, "/etc/passwd", O_RDONLY, 0); break;
#else
        case 1: result = syscall(SYS_openat, AT_FDCWD, "/etc/passwd", O_WRONLY, 0); break;
#endif
        case 2: result = syscall(SYS_unlinkat, AT_FDCWD, "/tmp/target", 0); break;
        case 3: result = syscall(SYS_socket, AF_INET, SOCK_STREAM, 0); break;
        case 4: result = syscall(SYS_connect, -1, NULL, 0); break;
        case 5: result = syscall(SYS_execve, "/bin/true", NULL, NULL); break;
        case 6: result = syscall(SYS_unshare, 0); break;
        case 7: result = syscall(SYS_ptrace, 0, 0, NULL, NULL); break;
        case 8: result = syscall(SYS_setuid, 0); break;
        case 9: result = syscall(SYS_io_uring_setup, 1, NULL); break;
        case 10: result = syscall(SYS_openat2, AT_FDCWD, "/etc/passwd", NULL, 0); break;
#if defined(__x86_64__)
        case 11: result = syscall(SYS_creat, "/tmp/target", 0600); break;
        case 12: result = syscall(SYS_rename, "/tmp/a", "/tmp/b"); break;
#else
        case 11: result = syscall(SYS_openat, AT_FDCWD, "/tmp/target", O_CREAT|O_WRONLY, 0600); break;
        case 12: result = syscall(SYS_renameat2, AT_FDCWD, "/tmp/a", AT_FDCWD, "/tmp/b", 0); break;
#endif
        case 13: result = syscall(SYS_socketpair, AF_UNIX, SOCK_STREAM, 0, NULL); break;
        case 14: result = syscall(SYS_clone, 0, NULL, NULL, NULL, 0); break;
        case 15: result = syscall(SYS_clone3, NULL, 0); break;
        case 16: result = syscall(SYS_setns, -1, 0); break;
        case 17: result = syscall(SYS_process_vm_readv, getpid(), NULL, 0, NULL, 0, 0); break;
        case 18: result = syscall(SYS_capset, NULL, NULL); break;
        case 19: result = syscall(SYS_io_uring_enter, -1, 0, 0, 0, NULL, 0); break;
        case 20: result = syscall(SYS_io_uring_register, -1, 0, NULL, 0); break;
        case 21: result = syscall(SYS_mmap, NULL, 4096, PROT_READ, MAP_PRIVATE, unrelated_fd, 0); break;
        case 22: result = syscall(SYS_dup, 0); break;
        /* x86_64 tests x32 openat; arm64 tests an unknown syscall number.
         * AArch64 has no x32 ABI. Both must receive filter EPERM, not ENOSYS. */
        case 23: result = syscall(SYS_openat | 0x40000000, AT_FDCWD, "/etc/passwd", O_RDONLY, 0); break;
        default: return 0;
    }
    return result == -1 && errno == EPERM ? -1 : 0;
}
