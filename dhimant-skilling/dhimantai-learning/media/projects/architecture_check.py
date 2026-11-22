"""Run inside the learner's course container against the public entry points."""
from pathlib import Path
import sys

root = Path.cwd().resolve()
sys.path.insert(0, str(root))
sys.dont_write_bytecode = True
# Ignore any bytecode from previous runs of the learner's project.
sys.pycache_prefix = '/dev/null'
case = sys.argv[1]


def observe(call, expected, ledger):
    """A shared decision returns the expected value without changing the ledger during its call."""
    decisions = set()
    entered = {}

    def trace(frame, event, value):
        if event not in ('call', 'return'):
            return
        code = frame.f_code
        if code.co_filename.startswith('<') or not Path(code.co_filename).resolve().is_relative_to(root):
            return
        if event == 'call':
            entered[frame] = list(ledger)
        elif entered.pop(frame, None) == ledger and type(value) is type(expected) and value == expected:
            decisions.add(code)

    sys.setprofile(trace)
    try:
        actual = call()
    finally:
        sys.setprofile(None)
    assert type(actual) is type(expected) and actual == expected, 'The result differs from the documented behavior.'
    return decisions


if case == 'market-checkout':
    import pricing
    preview, commit = pricing.preview, pricing.checkout
    cases = [((cents, member), cents - cents // 10 if member else cents)
             for cents in (0, 9, 10, 137, 1099) for member in (False, True)]
elif case == 'field-dispatch':
    from dispatch import DispatchDesk

    def preview(urgent, distance, board):
        return DispatchDesk(board).estimate(urgent, distance)

    def commit(urgent, distance, board):
        return DispatchDesk(board).assign(urgent, distance)

    cases = [((urgent, km), 'rapid' if urgent else 'regional' if km > 20 else 'local')
             for km in (0, 19, 20, 21, 70) for urgent in (False, True)]
elif case == 'parcel-pickup':
    from locker import lookup as preview, collect as commit
    cases = [((zone, oversized), 'freight' if oversized else zone)
             for zone in ('north', 'west', 'east') for oversized in (False, True)]
elif case in ('museum-entry', 'workshop-enrolment'):
    if case == 'museum-entry':
        from tickets import kiosk_youth as first_channel, online_youth as second_channel
        limit = 16
    else:
        from places import desk_accepts as first_channel, phone_accepts as second_channel
        limit = 8
    for number in (1, limit - 1, limit, limit + 1, 80):
        expected = number <= limit
        first = observe(lambda: first_channel(number), expected, [])
        second = observe(lambda: second_channel(number), expected, [])
        assert first & second, 'The example results agree. The repair still leaves the two channels able to drift on a policy change.'
    print('Passed. Both entry points agree below, at and above the boundary and share the decision.')
    sys.exit(0)
else:
    raise ValueError('Unknown practice case')

for inputs, expected in cases:
    ledger = ['previous record']
    first = observe(lambda: preview(*inputs, ledger), expected, ledger)
    assert ledger == ['previous record'], 'A preview changed the persistent record.'
    observe(lambda: preview(*inputs, None), expected, ledger)
    second = observe(lambda: commit(*inputs, ledger), expected, ledger)
    assert ledger == ['previous record', expected], 'Confirmation must record exactly one result.'
    assert first & second, ('Show one shared decision that can finish without writing a record.' if case == 'market-checkout'
                            else 'The output examples pass. The two operations can still diverge when the policy changes.')
print('Passed. Preview works offline, confirmation records once, and both paths share the decision across the boundary cases.')
