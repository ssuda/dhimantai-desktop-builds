"""Run from the Equipment Desk project terminal. Each invocation owns one disposable item."""
from html.parser import HTMLParser
from http.cookies import SimpleCookie
import json
import os
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

sys.path.insert(0, '/opt/build-studio')
from runtime import sql

BASE = 'http://127.0.0.1:8000'


class Page(HTMLParser):
    token = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta' and attrs.get('name') == 'csrf-token':
            self.token = attrs['content']


def check():
    headers = {'X-Studio-Run': os.environ['STUDIO_RUN'], 'Accept': 'application/json'}
    page = Page()
    with urlopen(Request(BASE, headers=headers), timeout=10) as response:
        page.feed(response.read().decode())
        cookies = [SimpleCookie(value.partition(';')[0]) for value in response.headers.get_all('Set-Cookie', [])]
    assert page.token, 'The checkout page must have a CSRF token'
    headers.update({'Cookie': '; '.join(m.OutputString() for jar in cookies for m in jar.values()),
                    'X-CSRF-TOKEN': page.token, 'Content-Type': 'application/json'})
    item = int(sql(f"INSERT INTO items(name,available) VALUES ('Test-{uuid4().hex}',3); SELECT LAST_INSERT_ID()"))

    def checkout(quantity):
        payload = json.dumps({'borrower':'course-test', 'quantity':quantity}).encode()
        try:
            response = urlopen(Request(f'{BASE}/items/{item}/loans', data=payload, headers=headers), timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status

    try:
        for quantity, expected, stock, loans in [(0,422,3,0), (2,201,1,1), (2,409,1,1)]:
            status = checkout(quantity)
            state = sql(f'SELECT available,(SELECT COUNT(*) FROM loans WHERE item_id={item}) FROM items WHERE id={item}')
            assert (status,state) == (expected,f'{stock}\t{loans}'), (quantity,status,state)
            print(f'Quantity {quantity}: HTTP {status}, stock {stock}, loans {loans}')
    finally:
        sql(f'DELETE FROM loans WHERE item_id={item}; DELETE FROM items WHERE id={item}')


if __name__ == '__main__':
    check()
