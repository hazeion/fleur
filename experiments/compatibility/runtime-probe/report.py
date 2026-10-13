"""Accept only complete evidence for this bounded experiment, never the v1 gate."""
def accept(report):
    return (report.get('install') == 0
            and report.get('html') == '<p>restricted render</p>'
            and report.get('main') == [-1] * 10
            and report.get('thread') == -1
            and report.get('application_open') is True)
