"""Own only a labeled experiment container, including uncertain launch results."""
import json

LABEL = 'fleur.compatibility.database-owner'


class OwnedContainer:
    def __init__(self, command, name, owner):
        self.command = command
        self.name = name
        self.owner = owner
        self.attempted = False

    def launch(self, arguments):
        # The daemon can create the resource before its client returns or times out.
        self.attempted = True
        return self.command(arguments)

    def inspect(self, absent_allowed=False):
        result = self.command(['docker', 'inspect', self.name])
        if result.returncode:
            if absent_allowed and ('No such object:' in result.stderr or 'No such container:' in result.stderr):
                return None
            raise RuntimeError('Owned database inspection failed')
        row = json.loads(result.stdout)[0]
        if row['Config']['Labels'].get(LABEL) != self.owner or row['Name'] != '/' + self.name:
            raise RuntimeError('Container ownership mismatch; no cleanup authority')
        return row

    def cleanup(self):
        if not self.attempted:
            return True
        row = self.inspect(absent_allowed=True)
        if row is None:
            return True
        return self.command(['docker', 'rm', '--force', '--volumes', self.name]).returncode == 0
