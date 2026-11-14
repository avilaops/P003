import errno
import struct
import unittest
from unittest.mock import patch

from helpers import load


def evaluate(program, number, architecture, arguments=()):
    """Tiny classic-BPF evaluator for boundary vectors; real installation is Linux CI."""
    memory = struct.pack('<IIQ6Q', number, architecture, 0, *(tuple(arguments)+(0,)*(6-len(arguments))))
    cursor, accumulator = 0, 0
    while cursor < len(program):
        code, yes, no, value = program[cursor]
        cursor += 1
        if code == 0x20: accumulator = struct.unpack_from('<I', memory, value)[0]
        elif code == 0x54: accumulator &= value
        elif code == 0x15: cursor += yes if accumulator == value else no
        elif code == 0x35: cursor += yes if accumulator >= value else no
        elif code == 0x45: cursor += yes if accumulator & value else no
        elif code == 0x06: return value
        else: raise AssertionError('unknown_filter_instruction')
    raise AssertionError('filter_fell_through')


class KernelJailPolicyTests(unittest.TestCase):
    def setUp(self): self.api = load(self, 'jail')

    def test_unsupported_platform_fails_closed(self):
        with patch.object(self.api.sys, 'platform', 'win32'):
            with self.assertRaises(self.api.KernelJailError): self.api.kernel_abi()
        with self.assertRaises(self.api.KernelJailError): self.api.build_filter('unknown')

    def test_syscall_filter_covers_signal_memory_namespace_and_compatibility_interfaces(self):
        denied = 0x00050000 | errno.EPERM
        for name, architecture, numbers in (
            ('x86_64', 0xc000003e, (62, 109, 112, 101, 200, 234, 129, 297, 272, 308, 310, 311, 424, 425, 426, 427, 438)),
            ('aarch64', 0xc00000b7, (129, 154, 157, 117, 130, 131, 138, 240, 97, 268, 270, 271, 424, 425, 426, 427, 438))):
            program = self.api.build_filter(name)
            for number in numbers:
                with self.subTest(architecture=name, syscall=number):
                    self.assertEqual(evaluate(program, number, architecture), denied)
            self.assertEqual(evaluate(program, 435, architecture), 0x00050000 | errno.ENOSYS)
            self.assertEqual(evaluate(program, 0x40000000 | 62, architecture), denied)
            self.assertEqual(evaluate(program, 0, 0x40000003), 0x80000000)

    def test_clone_only_keeps_the_owned_group_and_safe_child_exit_signals(self):
        for name, architecture, clone in (('x86_64', 0xc000003e, 56), ('aarch64', 0xc00000b7, 220)):
            program = self.api.build_filter(name)
            for flags in (0x20000000 | 17, 0x10000000 | 17, 0x8000 | 17, 19):
                self.assertEqual(evaluate(program, clone, architecture, (flags,)), 0x00050000 | errno.EPERM)
            for flags in (0, 17, 0x10000 | 0x100 | 0x800):
                self.assertEqual(evaluate(program, clone, architecture, (flags,)), 0x7fff0000)

    def test_resource_limits_cannot_be_changed_via_prlimit_but_reads_are_allowed(self):
        for name, architecture, number in (('x86_64', 0xc000003e, 302), ('aarch64', 0xc00000b7, 261)):
            program = self.api.build_filter(name)
            self.assertEqual(evaluate(program, number, architecture, (0, 0, 0)), 0x7fff0000)
            for pointer in (1, 1 << 32):
                self.assertEqual(evaluate(program, number, architecture, (0, 0, pointer)),
                                 0x00050000 | errno.EPERM)
