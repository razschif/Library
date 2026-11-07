"""
convert.py - turns books.xlsx into books.json (for the website)
             and apps-script/Books.gs (the list of valid books for the server).

How to run (from this folder):
    python convert.py

What it does:
  1. Reads every cell of books.xlsx as text and trims spaces.
  2. Skips empty rows, rows without a title, rows with invalid years,
     and rows that are not approved (column "האם אושר?").
  3. Gives every book a numeric id. A book KEEPS its id between runs
     (ids are matched by title from the previous books.json), so choices that
     were already saved on the server keep pointing to the right book.
  4. Finds a link for every book:
       a. a file in the Books/ folder whose name matches the title, or
       b. the web link (http/https) written in the Excel file.
     Links to files on someone's own computer (file:///...) are ignored.
  5. Finds an optional cover picture in the covers/ folder (see README).
  6. Writes books.json and apps-script/Books.gs.
"""

import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent
EXCEL_FILE = HERE / "books.xlsx"
JSON_FILE = HERE / "books.json"
SERVER_BOOKS_FILE = HERE / "apps-script" / "Books.gs"
BOOKS_FOLDER = "Books"     # folder with the digital copies (PDF / EPUB)
COVERS_FOLDER = "covers"   # folder with optional cover pictures

COVER_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

# The Excel headers we accept for each JSON key.
# Headers are compared after trimming spaces, so "שם הספר " also matches.
# "required" columns must exist; the others are optional.
COLUMNS = {
    "title":       {"headers": ["שם הספר", "שם", "כותר"], "required": True},
    "author":      {"headers": ["סופר", "מחבר", "כותב"], "required": True},
    "subject":     {"headers": ["שיוך נושאי", "נושא", "מקצוע"], "required": True},
    "years":       {"headers": ["האם אושר רק לשנה ספציפית?", "שנים", "שנה"], "required": True},
    "description": {"headers": ["תקציר", "תיאור"], "required": True},
    "approved":    {"headers": ["האם אושר?", "אושר"], "required": False},
    "link":        {"headers": ["עותק דיגיטלי/מיקום הספר", "קישור", "עותק דיגיטלי"], "required": False},
    "cover":       {"headers": ["כריכה", "תמונת כריכה"], "required": False},
}

# Values in the "approved" column that mean "yes".
APPROVED_VALUES = {"1", "כן", "v", "✓", "true", "yes"}

# Hebrew year letters -> year numbers.
YEAR_LETTERS = {"א": 1, "ב": 2, "ג": 3}


# ---------------------------------------------------------------------------
# Reading the Excel file
# ---------------------------------------------------------------------------

def cell_to_text(value):
    """Turn any cell value into trimmed text ("" for empty cells)."""
    if value is None:
        return ""
    # Whole numbers stored as floats (1.0) should become "1", not "1.0".
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = str(value).strip()
    return "" if text.lower() == "nan" else text


def read_rows_with_pandas(path):
    """Read the first sheet with pandas. Returns (headers, list of rows)."""
    import pandas as pd
    table = pd.read_excel(path, dtype=str, keep_default_na=False, engine="openpyxl")
    headers = [cell_to_text(h) for h in table.columns]
    rows = [[cell_to_text(v) for v in row] for row in table.itertuples(index=False)]
    return headers, rows


def read_rows_with_openpyxl(path):
    """Same as above, using openpyxl only (used if pandas can't load)."""
    import openpyxl
    sheet = openpyxl.load_workbook(path, read_only=True, data_only=True).active
    all_rows = [[cell_to_text(v) for v in row] for row in sheet.iter_rows(values_only=True)]
    if not all_rows:
        return [], []
    return all_rows[0], all_rows[1:]


def read_excel(path):
    """Read the Excel file. Tries pandas first, then plain openpyxl."""
    try:
        return read_rows_with_pandas(path)
    except ImportError as error:
        print(f"Note: pandas could not be loaded ({error}). Using openpyxl directly.")
        return read_rows_with_openpyxl(path)


def find_columns(headers):
    """Return {json_key: column_index} by matching the real Excel headers."""
    clean_headers = [h.strip() for h in headers]
    found = {}
    for key, rule in COLUMNS.items():
        for name in rule["headers"]:
            if name in clean_headers:
                found[key] = clean_headers.index(name)
                break
        if key not in found and rule["required"]:
            sys.exit(f"ERROR: could not find the column for '{key}'. "
                     f"Expected one of these headers: {rule['headers']}. "
                     f"Headers in the file: {clean_headers}")
    return found


# ---------------------------------------------------------------------------
# Turning cell text into clean values
# ---------------------------------------------------------------------------

def parse_years(text):
    """
    Turn the years cell into a sorted list of numbers. Examples:
      "מתאים לכולם"   -> [1, 2, 3]
      "כן, שנה ב'"     -> [2]
      "1,3"            -> [1, 3]
      "שנה ב' ו-ג'"    -> [2, 3]
    Returns [] if no valid year was found.
    """
    if "כולם" in text or "כל השנים" in text:
        return [1, 2, 3]
    years = {int(d) for d in re.findall(r"[1-3]", text)}
    # A Hebrew year letter followed by a geresh, e.g. א' or ב׳
    for letter in re.findall(r"(?<![א-ת])([אבג])['׳]", text):
        years.add(YEAR_LETTERS[letter])
    return sorted(years)


def words_of(text):
    """Split text into lowercase words (letters and digits only)."""
    text = text.lower().replace("'", "").replace("’", "")
    return set(re.findall(r"[0-9a-zא-ת]+", text))


def find_matching_file(folder, book, extensions=None):
    """
    Look for a file in `folder` whose name matches the book.
    A file matches if every word in its name appears in the book's title or author.
    For example "The Art of War - Sun Tzu.epub" matches the title "The Art of War"
    with the author "Sun Tzu". If several files match, the longest name wins.
    """
    folder_path = HERE / folder
    if not folder_path.is_dir():
        return None
    book_words = words_of(book["title"] + " " + book["author"])
    best = None
    for file in folder_path.iterdir():
        if not file.is_file() or (extensions and file.suffix.lower() not in extensions):
            continue
        file_words = words_of(file.stem)
        if file_words and file_words <= book_words:
            if best is None or len(file_words) > len(words_of(best.stem)):
                best = file
    return best


def file_url(folder, filename):
    """Make a web-safe relative link like 'Books/The%20Art%20of%20War.epub'."""
    return quote(f"{folder}/{filename}")


def resolve_link(book, link_cell, row_number):
    """Pick the best link for a book (local file first, then web link)."""
    # 1. The Excel cell names a file that exists in the Books folder.
    if link_cell and (HERE / BOOKS_FOLDER / link_cell).is_file():
        return file_url(BOOKS_FOLDER, link_cell)
    # 2. A file in the Books folder matches the title.
    match = find_matching_file(BOOKS_FOLDER, book)
    if match:
        return file_url(BOOKS_FOLDER, match.name)
    # 3. A normal web link.
    if link_cell.lower().startswith(("http://", "https://")):
        return link_cell
    if link_cell:
        print(f"Note (row {row_number}): no usable link for '{book['title']}' "
              f"(the Excel link points to a private computer, or the file is missing).")
    return ""


def resolve_cover(book, cover_cell):
    """Pick a cover picture from the covers folder, or "" if there is none."""
    if cover_cell and (HERE / COVERS_FOLDER / cover_cell).is_file():
        return file_url(COVERS_FOLDER, cover_cell)
    match = find_matching_file(COVERS_FOLDER, book, COVER_EXTENSIONS)
    return file_url(COVERS_FOLDER, match.name) if match else ""


# ---------------------------------------------------------------------------
# Keeping ids stable between runs
# ---------------------------------------------------------------------------

def title_key(title):
    """A normalized title, used to recognize the same book between runs."""
    return " ".join(sorted(words_of(title)))


def load_previous_ids():
    """Read the old books.json (if any) and return {title_key: id}."""
    if not JSON_FILE.exists():
        return {}
    try:
        old_books = json.loads(JSON_FILE.read_text(encoding="utf-8"))
        return {title_key(b["title"]): int(b["id"]) for b in old_books}
    except (ValueError, KeyError, TypeError):
        print("Warning: the old books.json could not be read, so ids start from 1.")
        return {}


def assign_ids(books):
    """Give every book an id. Known titles keep their old id; new titles get new ids."""
    previous = load_previous_ids()
    next_id = max(previous.values(), default=0) + 1
    used = set()
    for book in books:
        old_id = previous.get(title_key(book["title"]))
        if old_id is not None and old_id not in used:
            book["id"] = old_id
        else:
            book["id"] = next_id
            next_id += 1
        used.add(book["id"])


# ---------------------------------------------------------------------------
# Main program
# ---------------------------------------------------------------------------

def row_to_book(row, columns, row_number):
    """Turn one Excel row into a book dict, or None if the row must be skipped."""
    def get(key):
        index = columns.get(key)
        return row[index] if index is not None and index < len(row) else ""

    if not any(row):
        return None  # empty row: skip quietly

    title = get("title")
    if not title:
        print(f"Warning (row {row_number}): missing title - row skipped.")
        return None

    if "approved" in columns and get("approved").lower() not in APPROVED_VALUES:
        print(f"Note (row {row_number}): '{title}' is not approved - row skipped.")
        return None

    years = parse_years(get("years"))
    if not years:
        print(f"Warning (row {row_number}): invalid years '{get('years')}' "
              f"for '{title}' - row skipped.")
        return None

    book = {
        "id": None,  # filled in later by assign_ids()
        "title": title,
        # Remove a leading dash, e.g. "- אוסף מאמרים" -> "אוסף מאמרים"
        "author": re.sub(r"^[-–]\s*", "", get("author")),
        "subject": get("subject"),
        "years": years,
        "description": get("description"),
    }
    book["link"] = resolve_link(book, get("link"), row_number)
    book["cover"] = resolve_cover(book, get("cover"))
    return book


def write_server_books(books):
    """Write apps-script/Books.gs: the list of valid book ids for the server."""
    titles = {str(b["id"]): b["title"] for b in sorted(books, key=lambda b: b["id"])}
    content = (
        "// Books.gs - CREATED AUTOMATICALLY by convert.py. Do not edit by hand.\n"
        "// The server only accepts choices for the book ids listed here.\n"
        "// After the book list changes: copy this file into the Apps Script project\n"
        "// again and publish a new version (see README).\n\n"
        "var BOOK_TITLES = " + json.dumps(titles, ensure_ascii=False, indent=2) + ";\n"
    )
    SERVER_BOOKS_FILE.parent.mkdir(exist_ok=True)
    SERVER_BOOKS_FILE.write_text(content, encoding="utf-8")


def main():
    # Windows terminals sometimes can't print Hebrew without this line.
    sys.stdout.reconfigure(encoding="utf-8")

    headers, rows = read_excel(EXCEL_FILE)
    columns = find_columns(headers)

    books = []
    for index, row in enumerate(rows):
        book = row_to_book(row, columns, row_number=index + 2)  # +2: header row, 1-based
        if book:
            books.append(book)

    assign_ids(books)
    books.sort(key=lambda b: b["id"])

    JSON_FILE.write_text(json.dumps(books, ensure_ascii=False, indent=2), encoding="utf-8")
    write_server_books(books)

    with_link = sum(1 for b in books if b["link"])
    with_cover = sum(1 for b in books if b["cover"])
    print(f"Done: {len(books)} books written to {JSON_FILE.name} "
          f"({with_link} with a link, {with_cover} with a cover).")
    print(f"Also updated {SERVER_BOOKS_FILE.relative_to(HERE)} - "
          f"copy it to Apps Script if the list of books changed.")


if __name__ == "__main__":
    main()
