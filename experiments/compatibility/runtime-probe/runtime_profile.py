"""Explicit native Linux profiles with executed per-architecture compiler pins."""
PROFILES = {
    'amd64': {'machines': ('x86_64',), 'compiler_target': 'x86_64-linux-gnu',
              'base': 'oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e',
              'compiler_sha256': '1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26'},
    'arm64': {'machines': ('aarch64', 'arm64'), 'compiler_target': 'aarch64-linux-gnu',
              'base': 'oven/bun@sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023',
              'compiler_sha256': 'a20520ee21543f243d40636a9181a142c45ecd989de31ab86b99a8ea5ada870d'},
}


def select_profile(architecture, system, machine):
    if architecture is None:
        architecture = next((name for name, item in PROFILES.items() if machine in item['machines']), None)
    if system != 'Linux' or type(architecture) is not str or architecture not in PROFILES or machine not in PROFILES[architecture]['machines']:
        raise ValueError('requires matching native Linux amd64 or arm64 Docker runner')
    return architecture, PROFILES[architecture]


def native_elf_identity(header, architecture):
    expected = {'amd64':62,'arm64':183}.get(architecture)
    if expected is None or len(header) < 64 or header[:6] != b'\x7fELF\x02\x01':
        raise ValueError('compiled helper must use native 64-bit little-endian ELF')
    machine = int.from_bytes(header[18:20], 'little')
    if machine != expected:
        raise ValueError('compiled ELF machine differs from native architecture')
    return {'class':64,'endianness':'little','machine':machine}
