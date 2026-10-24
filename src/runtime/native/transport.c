/* The syscall policy is unchanged from the qualified native candidate.
 * Transport adds no descriptors, syscalls, sockets, or ambient authority. */
#include "restriction.c"
#define FRAME_MAX (2U * 1024U * 1024U)

static int transfer(int fd, void *buffer, uint32_t length, int writing) {
    unsigned char *cursor = buffer;
    unsigned interruptions = 0;
    while (length) {
        ssize_t count = writing ? syscall(SYS_write, fd, cursor, length)
                                : syscall(SYS_read, fd, cursor, length);
        if (count < 0 && errno == EINTR && ++interruptions < 64) continue;
        if (count <= 0 || (uint64_t)count > length) return -1;
        cursor += count;
        length -= (uint32_t)count;
    }
    return 0;
}
static int send_frame(const void *request, uint32_t length) {
    if (!request || !length || length > FRAME_MAX) return -1;
    unsigned char header[] = {length >> 24, length >> 16, length >> 8, length};
    if (transfer(1, header, 4, 1)) return -1;
    return transfer(1, (void *)request, length, 1);
}
int frame_receive(void *response, uint32_t capacity) {
    unsigned char header[4];
    if (!response || capacity > FRAME_MAX || transfer(0, header, 4, 0)) return -1;
    uint32_t length = ((uint32_t)header[0] << 24) | ((uint32_t)header[1] << 16)
                    | ((uint32_t)header[2] << 8) | header[3];
    if (!length || length > capacity || transfer(0, response, length, 0)) return -1;
    return (int)length;
}
int frame_exchange(const void *request, uint32_t length, void *response, uint32_t capacity) {
    if (send_frame(request, length)) return -1;
    return frame_receive(response, capacity);
}
_Noreturn void frame_finish(const void *request, uint32_t length) {
    int result = send_frame(request, length);
    syscall(SYS_exit_group, result ? 25 : 0);
    __builtin_unreachable();
}
