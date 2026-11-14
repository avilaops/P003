"""Linux kernel fences for child file access and supervisor/process isolation.

Installed before exec of any parser/collector. No dependency on Yama, shell,
privileged helper or a best-effort fallback. See deploy README for kernel ABI.
"""
import ctypes
import errno
import os
from pathlib import Path
import platform
import sys
import sysconfig

_ALLOW, _DENY, _KILL = 0x7fff0000, 0x00050000 | errno.EPERM, 0x80000000
_ARCHES = {
    'x86_64': (0xc000003e, 56, 302, (62, 109, 112, 101, 129, 141, 142, 144, 160,
        200, 203, 234, 251, 272, 297, 298, 308, 310, 311, 312, 314, 321, 323)),
    'aarch64': (0xc00000b7, 220, 261, (30, 97, 117, 118, 119, 122, 129, 130, 131,
        138, 140, 154, 157, 164, 240, 241, 268, 270, 271, 272, 274, 280, 282))}


class KernelJailError(ValueError):
    def __init__(self): super().__init__('validation_kernel_isolation_unavailable')


def _architecture():
    name = platform.machine().lower()
    name = {'amd64': 'x86_64', 'arm64': 'aarch64'}.get(name, name)
    if name not in _ARCHES or sys.byteorder != 'little': raise KernelJailError()
    return name


def _libc():
    if sys.platform != 'linux': raise KernelJailError()
    _architecture()
    library = ctypes.CDLL(None, use_errno=True)
    library.syscall.restype = ctypes.c_long
    return library


def kernel_abi():
    library = _libc()
    abi = library.syscall(444, ctypes.c_void_p(), ctypes.c_size_t(0), ctypes.c_uint(1))
    if abi < 3: raise KernelJailError()
    return abi


def protect_supervisor():
    library = _libc()
    if library.prctl(4, ctypes.c_ulong(0), 0, 0, 0) != 0: raise KernelJailError()  # PR_SET_DUMPABLE


def build_filter(architecture):
    if architecture not in _ARCHES: raise KernelJailError()
    audit, clone, prlimit, blocked = _ARCHES[architecture]
    instructions, labels = [], {}
    def emit(code, value, yes=0, no=0): instructions.append((code, yes, no, value))
    def label(name): labels[name] = len(instructions)
    emit(0x20, 4)  # seccomp_data.arch
    emit(0x15, audit, yes=1)
    emit(0x06, _KILL)
    emit(0x20, 0)  # seccomp_data.nr
    emit(0x35, 0x40000000, yes='deny')  # x32/unknown compatibility numbers cannot bypass native rules
    for number in sorted(set((*blocked, 424, 425, 426, 427, 434, 438, 440, 448))):
        emit(0x15, number, yes='deny')
    emit(0x15, 435, yes='clone3')  # ENOSYS gives libc its normal fork/clone fallback
    emit(0x15, clone, yes='clone')
    emit(0x15, prlimit, yes='prlimit')
    emit(0x06, _ALLOW)
    label('clone')
    emit(0x20, 16)
    emit(0x45, 0x7e028080, yes='deny')  # namespace flags + CLONE_PARENT + CLONE_NEWTIME
    emit(0x54, 0xff)  # CSIGNAL: an exit signal must not stop/kill a supervisor
    emit(0x15, 0, yes='allow')
    emit(0x15, 17, yes='allow')  # SIGCHLD
    emit(0x06, _DENY)
    label('prlimit')
    emit(0x20, 32)  # new_limit pointer (argument2), low and high words
    emit(0x15, 0, no='deny')
    emit(0x20, 36)
    emit(0x15, 0, yes='allow', no='deny')
    label('clone3')
    emit(0x06, 0x00050000 | errno.ENOSYS)
    label('allow')
    emit(0x06, _ALLOW)
    label('deny')
    emit(0x06, _DENY)
    output = []
    for index, (code, yes, no, value) in enumerate(instructions):
        jumps = tuple(labels[jump]-index-1 if isinstance(jump, str) else jump for jump in (yes, no))
        if any(not 0 <= jump <= 255 for jump in jumps): raise KernelJailError()
        output.append((code, *jumps, value))
    return tuple(output)


class _Filter(ctypes.Structure):
    _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint32)]


class _Program(ctypes.Structure):
    _fields_ = [('length', ctypes.c_ushort), ('filter', ctypes.POINTER(_Filter))]


class _Ruleset(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64)]


class _PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]


def _paths(command):
    # Runtime libraries/packages, never an entire checkout, /run, /etc or /proc.
    paths = {Path(value): 12 for value in sys.path if value and Path(value).is_absolute()}
    # CPython's site initialization reopens this exact file after exec, before
    # importing any service module. Grant no read access to the enclosing venv.
    paths[Path(sys.prefix)/'pyvenv.cfg'] = 4
    for name in ('stdlib', 'platstdlib', 'purelib', 'platlib'):
        paths[Path(sysconfig.get_path(name))] = 12
    for value in ('/lib', '/lib64', '/usr/lib', '/usr/local/lib', '/etc/ssl/certs', '/usr/share/zoneinfo'):
        paths[Path(value)] = 12
    for value in ('/etc/ld.so.cache', '/etc/hosts', '/etc/resolv.conf', '/etc/nsswitch.conf',
                  '/etc/host.conf', '/etc/gai.conf', '/etc/localtime', '/dev/urandom', '/dev/random'):
        paths[Path(value)] = 4
    paths[Path('/dev/null')] = 6  # Harmless character sink; no regular-file writes.
    root = Path(os.environ.get('VALIDATOR_CONFIG_ROOT', '/config/public'))
    if not root.is_absolute(): raise KernelJailError()
    paths[root] = 12
    paths[Path(command[0])] = 5
    for value in ('/lib64/ld-linux-x86-64.so.2', '/lib/ld-linux-aarch64.so.1'):
        paths[Path(value)] = 5
    # Only trusted caller-supplied Python scripts, e.g. the explicitly mounted CI
    # harness. HTTP/jobs never select commands, paths, environment or this list.
    for value in command[1:]:
        if Path(value).is_absolute() and Path(value).suffix == '.py': paths[Path(value)] = 4
    resolved = {}
    for path, access in paths.items():
        if not path.exists(): continue
        path = path.resolve(strict=True)
        for forbidden in (Path('/proc'), Path('/run/secrets')):
            if path.is_relative_to(forbidden) or forbidden.is_relative_to(path): raise KernelJailError()
        if path.is_file(): access &= ~8
        resolved[path] = resolved.get(path, 0) | access
    return resolved


def restrict_child(command):
    library, abi = _libc(), kernel_abi()
    if library.prctl(38, ctypes.c_ulong(1), 0, 0, 0) != 0: raise KernelJailError()  # NO_NEW_PRIVS
    # Filesystem rights known since ABI3; include device ioctl on ABI5+. Unhandled
    # TCP/UDP rights remain available only to the network collector; PDF worker has
    # its separate no-network namespace. Existing stdio is only pipes/devnull.
    attributes = _Ruleset((1 << (16 if abi >= 5 else 15))-1)
    ruleset = library.syscall(444, ctypes.byref(attributes), ctypes.sizeof(attributes), 0)
    if ruleset < 0: raise KernelJailError()
    try:
        for path, access in _paths(command).items():
            descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = _PathRule(access, descriptor)
                if library.syscall(445, ruleset, 1, ctypes.byref(rule), 0) != 0: raise KernelJailError()
            finally: os.close(descriptor)
        if library.syscall(446, ruleset, 0) != 0: raise KernelJailError()
    finally: os.close(ruleset)
    data = build_filter(_architecture())
    array = (_Filter*len(data))(*(_Filter(*row) for row in data))
    program = _Program(len(data), array)
    if library.prctl(22, 2, ctypes.byref(program), 0, 0) != 0: raise KernelJailError()  # SECCOMP_MODE_FILTER
