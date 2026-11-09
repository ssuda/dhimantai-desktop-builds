"""Small callers that give us a route into a large library. No edits required."""
from io import StringIO

from rich.console import Console
from rich.table import Table
from rich.text import Text


def plain_text():
    output = StringIO()
    console = Console(file=output, width=20, color_system=None)
    console.print("Hello, reader!", markup=False, highlight=False)
    print(repr(output.getvalue()))


def markup():
    text = Text.from_markup("[bold]Hello[/bold], reader!")
    print("plain:", repr(text.plain))
    print("spans:", text.spans)
    output = StringIO()
    Console(file=output, color_system=None).print(text)
    print("rendered:", repr(output.getvalue()))


def table():
    books = Table("Title", "Year", box=None, padding=0)
    books.add_row("Dune", "1965")
    books.add_row("Kindred", "1979")
    output = StringIO()
    Console(file=output, width=30, color_system=None).print(books)
    print(output.getvalue(), end="")


class Greeting:
    def __rich_console__(self, console, options):
        yield Text("Hello from a custom renderable!")


def protocol():
    output = StringIO()
    Console(file=output, width=40, color_system=None).print(Greeting())
    print(repr(output.getvalue()))
