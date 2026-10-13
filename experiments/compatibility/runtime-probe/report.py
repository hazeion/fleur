"""Accept complete typed evidence and confirmed cleanup, never the v1 gate."""
def accept(report):
    if not isinstance(report, dict):
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
