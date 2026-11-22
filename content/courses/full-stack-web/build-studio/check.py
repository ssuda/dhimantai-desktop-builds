"""Grade a private run by HTTP and read back its own persistent state.

One fixed scenario cannot tell the stock rule from a lookalike. A hard-coded threshold
(`available < 3`) and the off-by-one (`available <= quantity`, which refuses the last unit)
both pass "borrow 2 of 3, then 2 of 1". Each case below starts from its own stock, so the
rule must compare the requested quantity with what is actually available, including the
boundary where the request equals the stock.
"""
from html.parser import HTMLParser
from http.cookies import SimpleCookie
import json
import os
from subprocess import CalledProcessError
from urllib.error import HTTPError, URLError
from urllib.request import build_opener, Request

# (stock before, quantity requested, expected HTTP status)
CASES = (
    (1, 1, 201),    # borrowing exactly what remains is allowed
    (3, 2, 201),
    (1, 2, 409),    # one more than remains is refused
    (0, 1, 409),
    (19, 20, 409),  # a valid quantity that still exceeds stock
    (20, 20, 201),
)


class Page(HTMLParser):
    token = ''

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'meta' and values.get('name') == 'csrf-token':
            self.token = values['content']


def expected_state(stock, quantity, status):
    """Stock left, total loans and matching loans after one request from a clean table."""
    return (stock - quantity, 1, 1) if status == 201 else (stock, 0, 0)


def setup_problem(home_status, token, camera):
    """A reason the stock rule cannot be checked at all, so the learner fixes that first."""
    if home_status != 200:
        return (f'The home page returned HTTP {home_status}' if home_status else 'The app did not respond') + (
            ', so no checkout could be sent. Open Run App to see the error.')
    if not token:
        return 'The home page has no CSRF token, so Laravel would refuse every checkout. Check the csrf-token meta tag.'
    if camera is None:
        return 'No Camera item was found in the items table, so there was nothing to borrow.'
    return None


def needs_setup(problem):
    return {'passed': False, 'setup': problem, 'observations': []}


def evaluate(borrow, cases=CASES):
    """`borrow(stock, quantity)` resets the item, sends one checkout and returns (status, state)."""
    observations, passed = [], True
    for stock, quantity, expected in cases:
        status, state = borrow(stock, quantity)
        ok = status == expected and state == expected_state(stock, quantity, expected)
        observations.append({'stock': stock, 'quantity': quantity, 'expected': expected,
                             'status': status, 'stockAndLoans': '\t'.join(map(str, state)), 'passed': ok})
        passed = passed and ok
    return {'passed': passed, 'observations': observations}


def check():
    from runtime import sql
    if os.environ.get('STUDIO_KIND') != 'check':
        raise RuntimeError('A disposable check run is required')
    # Use a single Laravel session on this check run's loopback, with its own DB socket.
    client = build_opener()
    base = 'http://127.0.0.1:8000'
    headers = {'X-Studio-Run': os.environ['STUDIO_RUN'], 'Accept': 'application/json'}

    def fetch(path, payload=None):
        """The response, or None when the app did not answer."""
        request = Request(base + path, headers=headers, data=None if payload is None else json.dumps(payload).encode())
        try:
            return client.open(request, timeout=6)
        except HTTPError as error:
            return error
        except (URLError, OSError):
            return None

    page, home = Page(), fetch('/')
    if home is not None:
        with home:
            page.feed(home.read().decode(errors='replace'))
            # Reuse the session on this single verified loopback origin, including Secure cookies.
            cookies = []
            for header in home.headers.get_all('Set-Cookie', []):
                cookie = SimpleCookie(header.partition(';')[0])
                cookies.extend(f'{name}={field.coded_value}' for name, field in cookie.items())
            headers['Cookie'] = '; '.join(cookies)
    try:
        found = sql("SELECT id FROM items WHERE name='Camera' LIMIT 1")
    except CalledProcessError:
        return needs_setup('The check could not read the items table. Did a migration rename or drop it?')
    item = int(found) if found.isdigit() else None
    problem = setup_problem(None if home is None else home.status, page.token, item)
    if problem:
        return needs_setup(problem)
    headers.update({'X-CSRF-TOKEN': page.token, 'Content-Type': 'application/json'})

    def borrow(stock, quantity):
        sql(f'DELETE FROM loans; UPDATE items SET available={stock} WHERE id={item};')
        response = fetch(f'/items/{item}/loans', {'quantity': quantity, 'borrower': 'course check'})
        status = None
        if response is not None:
            with response:
                status = response.status
        row = sql(f'SELECT available,(SELECT COUNT(*) FROM loans),'
                  f'(SELECT COUNT(*) FROM loans WHERE item_id={item} AND quantity={quantity}) FROM items WHERE id={item}')
        return status, tuple(int(value) for value in row.split('\t'))

    return evaluate(borrow)


if __name__ == '__main__':
    print(json.dumps(check()))
