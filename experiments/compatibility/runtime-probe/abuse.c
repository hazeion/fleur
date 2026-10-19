#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
/* Trusted throwaway executable tests cgroups, not application seccomp. */
static unsigned long long counter(const char *path, const char *name) {
    FILE *file = fopen(path, "r");
    if (!file) exit(20);
    char key[128]; unsigned long long value;
    while (fscanf(file, "%127s %llu", key, &value) == 2) {
        if (!strcmp(key, name)) { fclose(file); return value; }
    }
    fclose(file); exit(21);
}
static unsigned long long number(const char *path) {
    FILE *file = fopen(path, "r"); unsigned long long value;
    if (!file || fscanf(file, "%llu", &value) != 1) exit(22);
    fclose(file); return value;
}
static void *busy(void *unused) {
    (void)unused;
    volatile unsigned long value = 0;
    for (;;) value++;
    return NULL;
}
int main(int argc, char **argv) {
    if (argc == 3 && !strcmp(argv[2], "--host-audit")) {
        char acknowledgment[32];
        puts("[compat-resource] ready");
        fflush(stdout);
        if (!fgets(acknowledgment, sizeof acknowledgment, stdin) ||
            strcmp(acknowledgment, "[compat-resource] approved\n")) return 12;
    } else if (argc != 2) return 1;
    if (!strcmp(argv[1], "cpu")) {
        unsigned long long before = counter("/sys/fs/cgroup/cpu.stat", "nr_throttled");
        unsigned long long time_before = counter("/sys/fs/cgroup/cpu.stat", "throttled_usec");
        pthread_t threads[4];
        for (int i = 0; i < 4; i++) if (pthread_create(&threads[i], NULL, busy, NULL)) return 2;
        struct timespec duration = {2, 0};
        nanosleep(&duration, NULL);
        unsigned long long after = counter("/sys/fs/cgroup/cpu.stat", "nr_throttled");
        unsigned long long time_after = counter("/sys/fs/cgroup/cpu.stat", "throttled_usec");
        printf("{\"throttled_periods\":%llu,\"throttled_usec\":%llu}\n", after-before, time_after-time_before);
        return after > before && time_after > time_before ? 0 : 3;
    }
    if (!strcmp(argv[1], "memory")) {
        /* The parent survives to attribute SIGKILL to actual cgroup OOM.
         * The pressure child is the only large consumer in this container. */
        unsigned long long max = number("/sys/fs/cgroup/memory.max");
        unsigned long long swap = number("/sys/fs/cgroup/memory.swap.max");
        unsigned long long oom_before = counter("/sys/fs/cgroup/memory.events", "oom");
        unsigned long long kill_before = counter("/sys/fs/cgroup/memory.events", "oom_kill");
        if (max != 536870912 || swap != 0) return 8;
        pid_t child = fork();
        if (child < 0) return 9;
        if (child == 0) {
            /* Touch pages, not virtual reservations. No host memory or swap. */
            for (int i = 0; i < 80; i++) {
                volatile unsigned char *block = malloc(16 * 1024 * 1024);
                if (!block) _exit(4);
                for (size_t n = 0; n < 16 * 1024 * 1024; n += 4096) block[n] = 1;
            }
            _exit(5);
        }
        int status;
        pid_t waited;
        do { waited = waitpid(child, &status, 0); } while (waited == -1 && errno == EINTR);
        if (waited != child) return 10;
        unsigned long long oom_after = counter("/sys/fs/cgroup/memory.events", "oom");
        unsigned long long kill_after = counter("/sys/fs/cgroup/memory.events", "oom_kill");
        int child_signal = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
        printf("{\"child_signal\":%d,\"oom_events_delta\":%llu,\"oom_kill_delta\":%llu,\"memory_max\":%llu,\"swap_max\":%llu}\n",
               child_signal, oom_after-oom_before, kill_after-kill_before, max, swap);
        return child_signal == SIGKILL && oom_after > oom_before && kill_after > kill_before ? 0 : 11;
    }
    if (!strcmp(argv[1], "pids")) {
        pid_t children[128]; int count = 0;
        for (; count < 128; count++) {
            pid_t child = fork();
            if (child == -1) break;
            if (child == 0) { for (;;) pause(); }
            children[count] = child;
        }
        int failure = errno;
        unsigned long long current = number("/sys/fs/cgroup/pids.current");
        unsigned long long max = number("/sys/fs/cgroup/pids.max");
        unsigned long long events = counter("/sys/fs/cgroup/pids.events", "max");
        for (int i = 0; i < count; i++) kill(children[i], SIGKILL);
        for (int i = 0; i < count; i++) waitpid(children[i], NULL, 0);
        printf("{\"errno\":%d,\"current\":%llu,\"max\":%llu,\"limit_events\":%llu}\n", failure,current,max,events);
        return failure == EAGAIN && current == 64 && max == 64 && events > 0 ? 0 : 6;
    }
    return 7;
}
