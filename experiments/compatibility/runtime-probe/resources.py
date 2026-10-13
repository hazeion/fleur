"""Cgroup enforcement acceptance, independently of worker seccomp."""
def accept_resources(value):
    if not isinstance(value, dict):
        return False
    cpu, memory, pids = (value.get(key) for key in ('cpu', 'memory', 'pids'))
    if not all(isinstance(item, dict) for item in (cpu, memory, pids)):
        return False
    return (all(type(cpu.get(key)) is int and cpu[key] > 0 for key in ('throttled_periods','throttled_usec'))
            and type(memory.get('container_exit')) is int and memory['container_exit'] == 0
            and type(memory.get('child_signal')) is int and memory['child_signal'] == 9
            and all(type(memory.get(key)) is int and memory[key] > 0
                    for key in ('oom_events_delta','oom_kill_delta'))
            and type(memory.get('memory_max')) is int and memory['memory_max'] == 536870912
            and type(memory.get('swap_max')) is int and memory['swap_max'] == 0
            and type(memory.get('docker_oom_killed')) is bool
            and type(pids.get('errno')) is int and pids['errno'] == 11
            and type(pids.get('current')) is int and pids['current'] == 64
            and type(pids.get('max')) is int and pids['max'] == 64
            and type(pids.get('limit_events')) is int and pids['limit_events'] > 0)
