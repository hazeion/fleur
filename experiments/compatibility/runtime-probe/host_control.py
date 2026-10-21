"""Explicit host-only owned fixture context; no worker or release admission."""
from dataclasses import dataclass
import math
import re
import time
from owned_guest import BOOT, NONCE, OwnedGuestContext, validate


@dataclass(frozen=True)
class HostControlContext:
    custody: OwnedGuestContext
    original: tuple
    deadline: float = 0.0

    def verify(self, remaining):
        if type(remaining) not in (int, float) or not math.isfinite(remaining) or remaining <= 0:
            raise ValueError('explicit owned host remaining budget required')
        if (type(self.custody) is not OwnedGuestContext
                or self.original != (self.custody.nonce, self.custody.boot_id, self.custody.uid, self.custody.manifest_sha256)):
            raise ValueError('original owned host context required')
        left = self.deadline - time.monotonic()
        if not math.isfinite(left) or left <= 0:
            raise ValueError('original owned host deadline expired')
        self.custody.verify(min(remaining, left))
        if time.monotonic() >= self.deadline:
            raise ValueError('original owned host deadline expired')

    def report(self):
        return {**self.custody.report(), 'hostControlScope': 'owned-guest', 'runtimeAdmission': False}


def authorize_host_control(context, *, remaining):
    if context is None:
        from daemon_trace import eligible_host
        if not eligible_host():
            raise RuntimeError('containerd proof host ineligible')
        return 'github-hosted'
    if type(context) is not HostControlContext:
        raise ValueError('explicit typed owned host control context required')
    context.verify(remaining)
    return 'owned-guest'


def select_owned_context(nonce=None, boot_id=None, uid=None, manifest_sha256=None, *, remaining, deadline=None):
    values = (nonce, boot_id, uid, manifest_sha256)
    if all(value is None for value in values):
        return None  # Legacy GitHub eligibility is checked by the existing caller.
    if any(value is None for value in values):
        raise ValueError('complete original owned guest binding required')
    if (type(nonce) is not str or re.fullmatch(NONCE, nonce) is None
            or type(boot_id) is not str or re.fullmatch(BOOT, boot_id) is None
            or type(uid) is not int or not 0 < uid < 2**31
            or type(manifest_sha256) is not str or re.fullmatch(r'[a-f0-9]{64}', manifest_sha256) is None
            or type(remaining) not in (int, float) or not math.isfinite(remaining) or remaining <= 0):
        raise ValueError('canonical original owned guest binding and budget required')
    started = time.monotonic()
    if deadline is not None and (type(deadline) not in (int, float) or not math.isfinite(deadline)):
        raise ValueError('original owned host deadline required')
    end = min(started + remaining, deadline) if deadline is not None else started + remaining
    if end <= started:
        raise ValueError('original owned host deadline expired')
    context = validate(nonce, deadline=min(end, started + 10))
    if (context.boot_id, context.uid, context.manifest_sha256) != (boot_id, uid, manifest_sha256):
        raise ValueError('owned guest differs from original session binding')
    return HostControlContext(context, values, end)
