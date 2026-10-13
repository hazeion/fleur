"""Cgroup enforcement acceptance, independently of worker seccomp."""
def accept_resources(value):
    if not isinstance(value, dict):
        return False
    cpu, memory, pids = (value.get(key) for key in ('cpu', 'memory', 'pids'))
    if not all(isinstance(item, dict) for item in (cpu, memory, pids)):
        return False
    return (all(type(cpu.get(key)) is int and cpu[key] > 0 for key in ('throttled_periods','throttled_usec'))
            and type(memory.get('exit')) is int and memory['exit'] == 137
            and memory.get('oom_killed') is True
            and type(pids.get('errno')) is int and pids['errno'] == 11
            and type(pids.get('current')) is int and pids['current'] == 64
            and type(pids.get('max')) is int and pids['max'] == 64
            and type(pids.get('limit_events')) is int and pids['limit_events'] > 0)
