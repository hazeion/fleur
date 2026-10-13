#define _GNU_SOURCE
#include <stdio.h>
#include <errno.h>
#include <dirent.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/eventfd.h>
#include <sys/epoll.h>
#include <stdint.h>
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
/* Temporary bounded diagnosis markers. No dynamic data or paths are emitted. */
void trace(int stage) {
    static const char *const markers[] = {
        "[DEBUG-runtime] loader-ready\n",
        "[DEBUG-runtime] profile-loaded\n",
        "[DEBUG-runtime] cgroups-read\n",
        "[DEBUG-runtime] source-read\n",
        "[DEBUG-runtime] warmup-start\n",
        "[DEBUG-runtime] warmup-done\n",
        "[DEBUG-runtime] prepare-start\n",
        "[DEBUG-runtime] prepare-ready\n",
        "[DEBUG-runtime] closure-start\n",
        "[DEBUG-runtime] closure-done\n",
        "[DEBUG-runtime] tsync-start\n",
        "[DEBUG-runtime] tsync-done\n",
        "[DEBUG-runtime] eval-compile-start\n",
        "[DEBUG-runtime] eval-compile-done\n",
        "[DEBUG-runtime] eval-call-start\n",
        "[DEBUG-runtime] eval-call-returned\n",
        "[DEBUG-runtime] eval-await-done\n",
        "[DEBUG-runtime] witness-start\n",
        "[DEBUG-runtime] witness-done\n",
        "[DEBUG-runtime] evidence-write\n",
        "[DEBUG-runtime] exit-start\n",
        "[DEBUG-runtime] ipc-send-start\n",
        "[DEBUG-runtime] ipc-sent\n",
        "[DEBUG-runtime] ipc-read-start\n",
        "[DEBUG-runtime] ipc-read-done\n",
        "[DEBUG-runtime] witness-activated\n",
        "[DEBUG-runtime] witness-native-done\n",
        "[DEBUG-runtime] controls-start\n",
        "[DEBUG-runtime] controls-done\n",
        "[DEBUG-runtime] render-start\n",
        "[DEBUG-runtime] render-done\n",
        "[DEBUG-runtime] file-read-start\n",
        "[DEBUG-runtime] file-promise-created\n",
        "[DEBUG-runtime] file-denied\n",
        "[DEBUG-runtime] file-unexpectedly-allowed\n",
    };
    if (stage < 0 || (size_t)stage >= sizeof(markers)/sizeof(markers[0])) return;
    syscall(SYS_write, 2, markers[stage], strlen(markers[stage]));
}
/* Trusted pre-TSYNC fixture: event bookkeeping is needed for asynchronous
 * completion, without admitting filesystem/network descriptors or creation. */
static int fixture_event_fd = -1;
static int fixture_poll_fd = -1;
static int fixture_event_errno;
int event_errno(void) { return fixture_event_errno; }
static int event_failure(int operation) { fixture_event_errno = errno; return operation; }
int event_prepare(void) {
    if (fixture_event_fd != -1 || fixture_poll_fd != -1) return -1;
    fixture_event_fd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    if (fixture_event_fd < 0) return -1;
    fixture_poll_fd = epoll_create1(EPOLL_CLOEXEC);
    if (fixture_poll_fd < 0) return -1;
    struct epoll_event event = {.events = EPOLLIN, .data.u64 = 0xF1E0};
    return epoll_ctl(fixture_poll_fd, EPOLL_CTL_ADD, fixture_event_fd, &event);
}
/* Return the failed operation number; zero requires genuine kernel readiness
 * and consumption. All operations run after TSYNC; no simulated completion. */
int event_probe(void) {
    uint64_t value = 1;
    if (syscall(SYS_write, fixture_event_fd, &value, sizeof(value)) != 8) return event_failure(1);
    struct epoll_event event = {0};
    if (syscall(SYS_epoll_pwait, fixture_poll_fd, &event, 1, 0, NULL, 8) != 1 ||
        event.data.u64 != 0xF1E0 || !(event.events & EPOLLIN)) return event_failure(2);
    struct timespec timeout = {0};
    event = (struct epoll_event){0};
    if (syscall(SYS_epoll_pwait2, fixture_poll_fd, &event, 1, &timeout, NULL, 8) != 1 ||
        event.data.u64 != 0xF1E0 || !(event.events & EPOLLIN)) return event_failure(3);
    value = 0;
    if (syscall(SYS_read, fixture_event_fd, &value, sizeof(value)) != 8 || value != 1) return event_failure(4);
    if (syscall(SYS_epoll_pwait, fixture_poll_fd, &event, 1, 0, NULL, 8) != 0) return event_failure(5);
    return 0;
}
/* New focused negative cases leave the existing 24 control contract unchanged. */
int event_negative(int choice) {
    uint64_t value[2] = {1, 0};
    struct epoll_event event = {.events = EPOLLIN};
    struct timespec timeout = {0};
    errno = 0;
    long result;
    switch (choice) {
        case 0: result = syscall(SYS_write, fixture_event_fd, value, sizeof(value)); break;
        case 1: result = syscall(SYS_read, fixture_event_fd, value, sizeof(value)); break;
        case 2: result = syscall(SYS_write, 999, value, 8); break;
        case 3: result = syscall(SYS_read, 999, value, 8); break;
        case 4: result = syscall(SYS_write, ((uint64_t)1 << 32) | (unsigned)fixture_event_fd, value, 8); break;
        case 5: result = syscall(SYS_read, fixture_event_fd, value, ((uint64_t)1 << 32) | 8); break;
        case 6: result = syscall(SYS_epoll_pwait, ((uint64_t)1 << 32) | (unsigned)fixture_poll_fd, &event, 1, 0, NULL, 8); break;
        case 7: result = syscall(SYS_epoll_pwait2, 999, &event, 1, &timeout, NULL, 8); break;
        case 8: result = syscall(SYS_eventfd2, 0, EFD_NONBLOCK); break;
        case 9: result = syscall(SYS_epoll_create1, EPOLL_CLOEXEC); break;
        case 10: result = syscall(SYS_epoll_ctl, fixture_poll_fd, EPOLL_CTL_DEL, fixture_event_fd, NULL); break;
        case 11: result = syscall(SYS_dup, fixture_event_fd); break;
        default: return 0;
    }
    return result == -1 && errno == EPERM ? -1 : 0;
}
/* One pre-existing native thread is a witness for TSYNC propagation. */
static pthread_t witness;
static int unrelated_fd;
static int closed_unrelated;
/* This inventory is frozen before TSYNC. Descriptor creation, duplication and
 * transfer remain denied afterward, so a closed number cannot be repurposed. */
#define EVENT_FD_LIMIT 64
static int event_read_fds[EVENT_FD_LIMIT], event_write_fds[EVENT_FD_LIMIT];
static int event_poll_fds[EVENT_FD_LIMIT];
static size_t event_read_count, event_write_count, event_poll_count;
static int event_inventory_frozen;
static int admit_event_fd(int *fds, size_t *count, int fd) {
    if (*count == EVENT_FD_LIMIT) return -1;
    fds[(*count)++] = fd;
    return 0;
}
static _Atomic int phase;
static _Atomic int thread_result;
static void *observe(void *unused) {
    (void)unused;
    atomic_store(&phase, 1);
    while (atomic_load(&phase) != 2) syscall(SYS_sched_yield);
    trace(25);
    long result = syscall(SYS_openat, AT_FDCWD, "/etc/passwd", O_RDONLY, 0);
    atomic_store(&thread_result, result == -1 && errno == EPERM ? -1 : 0);
    atomic_store(&phase, 3);
    trace(26);
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
    if (event_inventory_frozen || event_read_count || event_write_count || event_poll_count) return -1;
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
        int admission = 0;
        if (!strcmp(target, "anon_inode:[eventpoll]")) {
            admission = admit_event_fd(event_poll_fds, &event_poll_count, (int)descriptor);
        } else if (!strcmp(target, "anon_inode:[eventfd]")) {
            admission = admit_event_fd(event_read_fds, &event_read_count, (int)descriptor);
            if (!admission) admission = admit_event_fd(event_write_fds, &event_write_count, (int)descriptor);
        } else if (!strcmp(target, "anon_inode:[timerfd]")) {
            admission = admit_event_fd(event_read_fds, &event_read_count, (int)descriptor);
        } else {
            if (close((int)descriptor)) { closedir(directory); return -1; }
            continue;
        }
        if (admission) { closedir(directory); return -1; }
        continue;
    }
    if (closedir(directory)) return -1;
    errno = 0;
    closed_unrelated = fcntl(unrelated_fd, F_GETFD) == -1 && errno == EBADF;
    event_inventory_frozen = closed_unrelated;
    return closed_unrelated ? 0 : -1;
}
int descriptors_closed(void) { return closed_unrelated; }
/* Synchronous bounded stdio transport. Trusted host validates the request. */
int broker_exchange(void) {
    const char request[] = "{\"kind\":\"broker-request\",\"operation\":\"compat.query\",\"token\":\"probe-query\",\"action\":\"readExercise\",\"input\":{\"id\":1}}\n";
    trace(21);
    size_t sent = 0;
    while (sent < sizeof(request)-1) {
        ssize_t count = write(1, request+sent, sizeof(request)-1-sent);
        if (count <= 0) return -1;
        sent += (size_t)count;
    }
    trace(22);
    trace(23);
    char reply[4096]; size_t used = 0;
    while (used < sizeof(reply)-1) {
        ssize_t count = read(0, reply+used, 1);
        if (count != 1) return -1;
        if (reply[used++] == '\n') break;
    }
    reply[used] = 0;
    trace(24);
    return !strcmp(reply, "registered:Squat\n") ? 0 : -1;
}
#define ALLOW(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_##n, 0, 1), BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW)
/* Bounded cBPF construction: each descriptor handler has at most 147
 * instructions, below the 8-bit branch span; complete program stays <4096. */
#define FILTER_LIMIT 4096
_Static_assert(2 * EVENT_FD_LIMIT + 20 <= 255, "descriptor branch span exceeds cBPF bound");
_Static_assert(5 * (2 * EVENT_FD_LIMIT + 20) + 128 <= FILTER_LIMIT, "filter storage bound");
#define ARG_LOW(n) (offsetof(struct seccomp_data, args[n]))
#define ARG_HIGH(n) (offsetof(struct seccomp_data, args[n]) + 4)
static void emit(struct sock_filter *code, size_t *used, struct sock_filter instruction) {
    code[(*used)++] = instruction;
}
#define EMIT_STMT(op, value) emit(code, used, (struct sock_filter)BPF_STMT(op, value))
#define EMIT_JUMP(op, value, yes, no) emit(code, used, (struct sock_filter)BPF_JUMP(op, value, yes, no))
static void require_word(struct sock_filter *code, size_t *used, unsigned offset, uint32_t value) {
    EMIT_STMT(BPF_LD|BPF_W|BPF_ABS, offset);
    EMIT_JUMP(BPF_JMP|BPF_JEQ|BPF_K, value, 1, 0);
    EMIT_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM);
}
static void allow_fd(struct sock_filter *code, size_t *used, int fd) {
    EMIT_JUMP(BPF_JMP|BPF_JEQ|BPF_K, (uint32_t)fd, 0, 1);
    EMIT_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW);
}
/* stdio_count admits the existing transport without event-size restrictions.
 * Event handlers require all 64 bits of the descriptor and byte count. */
static void descriptor_handler(struct sock_filter *code, size_t *used, unsigned nr,
                               const int *fds, size_t count, const int *stdio_fds,
                               size_t stdio_count, int eight_bytes) {
    EMIT_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr));
    size_t dispatch = *used;
    EMIT_JUMP(BPF_JMP|BPF_JEQ|BPF_K, nr, 0, 0);
    require_word(code, used, ARG_HIGH(0), 0);
    EMIT_STMT(BPF_LD|BPF_W|BPF_ABS, ARG_LOW(0));
    for (size_t i = 0; i < stdio_count; i++) allow_fd(code, used, stdio_fds[i]);
    if (eight_bytes) {
        require_word(code, used, ARG_HIGH(2), 0);
        require_word(code, used, ARG_LOW(2), 8);
        EMIT_STMT(BPF_LD|BPF_W|BPF_ABS, ARG_LOW(0));
    }
    for (size_t i = 0; i < count; i++) allow_fd(code, used, fds[i]);
    EMIT_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM);
    code[dispatch].jf = (unsigned char)(*used - dispatch - 1);
}
int install(void) {
    /* Deny-by-default also rejects openat2, io_uring, clone3 and x32 numbers. */
    if (!event_inventory_frozen) return -1;
    const struct sock_filter common[] = {
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
    };
    struct sock_filter code[FILTER_LIMIT];
    size_t used = sizeof(common)/sizeof(common[0]);
    memcpy(code, common, sizeof(common));
    const int input[] = {0}, output[] = {1, 2};
    descriptor_handler(code, &used, SYS_read, event_read_fds, event_read_count, input, 1, 1);
    descriptor_handler(code, &used, SYS_write, event_write_fds, event_write_count, output, 2, 1);
    descriptor_handler(code, &used, SYS_writev, NULL, 0, output, 2, 0);
    descriptor_handler(code, &used, SYS_epoll_pwait, event_poll_fds, event_poll_count, NULL, 0, 0);
    descriptor_handler(code, &used, SYS_epoll_pwait2, event_poll_fds, event_poll_count, NULL, 0, 0);
    code[used++] = (struct sock_filter)BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM);
    if (used > FILTER_LIMIT) return -1;
    struct sock_fprog program = {(unsigned short)used, code};
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
