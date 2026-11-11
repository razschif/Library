# ספריית המודיעין – how to run, connect and update the site

## What each file does

| File | What it is |
|---|---|
| `index.html` | The page: header, filters, book cards, the two pop-ups |
| `style.css` | Colors, fonts and layout (colors are at the top, under `:root`) |
| `script.js` | Filters, sorting, cards, pop-ups, form checks |
| `api.js` | **The only file that talks to the server.** Paste the server URL here |
| `books.json` | The book list. Created by `convert.py` – don't edit by hand |
| `Books/` | Digital copies of the books (PDF / EPUB) |
| `covers/` | Optional cover pictures |
| `convert.py` | Turns `books.xlsx` into `books.json` and `apps-script/Books.gs` |
| `apps-script/Code.gs` | The server code (Google Apps Script) |
| `apps-script/Books.gs` | List of valid book ids for the server. Created by `convert.py` |
| `apps-script/DummyData.gs` | Optional. Adds or removes sample reviews and choices for trying out the site |

---

## 1. Run the site on your computer

The site must be opened through a small local server (double-clicking
`index.html` won't load the books, because browsers block that).

1. Open a terminal in this folder.
2. Run: `python -m http.server 8000`
3. Open <http://localhost:8000> in the browser.
4. Stop the server with `Ctrl+C`.

While `API_URL` in `api.js` is empty, the site runs in **demo mode**: a yellow
bar says so, and choices are kept only until the page is refreshed. This is
for trying the site out.

---

## 2. Set up the server (Google Sheet + Apps Script)

Do this once, with the Google account your unit approved.

**A. Create the sheet and the script**

1. Go to <https://sheets.google.com> and create a new, empty spreadsheet.
   Name it, for example, "ספריית המודיעין – בחירות".
2. In the menu: **Extensions → Apps Script**. A code editor opens in a new tab.
3. You'll see a file called `Code.gs` with a few lines in it. Delete them,
   and paste in **all** of `apps-script/Code.gs` from this folder.
4. Next to "Files", click **+ → Script**. Name it `Books` (Google adds `.gs`).
   Delete what's inside and paste in **all** of `apps-script/Books.gs`.
5. Click the 💾 **Save** icon.

**B. Publish it as a web app**

1. Click the blue **Deploy** button (top right) → **New deployment**.
2. Click the ⚙️ gear next to "Select type" → **Web app**.
3. Fill in:
   - Description: anything, e.g. `v1`
   - **Execute as: Me**
   - **Who has access: Anyone**  (participants don't need a Google account)
4. Click **Deploy**. Google asks for permission:
   **Authorize access** → choose your account → if you see "Google hasn't
   verified this app", click **Advanced → Go to (project name) (unsafe)** →
   **Allow**. (It's your own script, so this is expected.)
5. Copy the **Web app URL** (it ends with `/exec`).

**C. Connect the site**

1. Open `api.js` and paste the URL between the quotes:
   `const API_URL = "https://script.google.com/macros/s/.../exec";`
2. Check it works: open the URL in the browser with `?action=counts` at the
   end. You should see `{"ok":true,"counts":{}}`.
3. Refresh the site: the yellow demo bar is gone. Choose a book – a new tab
   called **בחירות** appears in the sheet with the choice.

**Changing the server code later** (for example after `Books.gs` changes):
paste the new code, Save, then **Deploy → Manage deployments → ✏️ (edit) →
Version: New version → Deploy**. The URL stays the same.
⚠️ Don't use "New deployment" again – that creates a *different* URL.

**Settings** at the top of `Code.gs`:
- `MAX_BOOKS_PER_PERSON = 0` means no limit. Set it to `1` to allow only one book per person.
- `DEPARTMENTS` lists the מחלקה options (now `1`, `2`, `3`), and
  `COHORTS_WITHOUT_DEPARTMENT` lists the מחזורים that have no מחלקות (now `סגל`).

**מחזור and מחלקה on the first choice.** The first time a person chooses a
book, the choose form also asks for their מחזור and, except for סגל, their
מחלקה. Later choices reuse them. They're saved in the columns **מחזור** and
**מחלקה** of the **בחירות** tab (the headers are added by themselves the next
time someone chooses a book) and shown in the admin control panel. People who
chose books before this was added are asked once, on their next choice. To
rename the מחלקות, change the options in the choose form in `index.html`
and `DEPARTMENTS` in `Code.gs` and in the demo server in `api.js`, keeping
them the same. If someone removes all their choices, they're asked again on
their next choice.

**Admins and the control panel.** Admins log in through the small
"כניסת מנהלים" button at the bottom of the site. The control panel shows what
everyone chose (by person or by book, with a search box) and has the setting
**"הצגת כריכות הספרים לכל המשתמשים"**, which turns book covers on or off for
everyone. Covers are off until an admin turns them on.

To add admins:
1. In the Apps Script editor, choose `setUpAdminTabs` in the function list at
   the top and click **Run** (once). It creates the tabs **מנהלים** and
   **הגדרות** in the sheet.
2. In the **מנהלים** tab, add one row per admin: full name, personal number
   and a password. The name must be typed the same way the admin will type it
   on the site.
3. To remove an admin, delete their row. No new deployment is needed for
   adding or removing admins.

After 5 wrong logins, that personal number is blocked from the control panel
for 15 minutes. The passwords are stored as plain text in the sheet, so anyone
who can open the sheet can see them – give each admin a password they don't
use anywhere else. The cover setting is saved in the **הגדרות** tab (`כן` /
`לא`), and can also be changed there by hand.

In demo mode (no server), the admin login is: name `מנהל הדגמה`, personal
number `1234567`, password `admin`.

**Privacy:** the sheet holds names and personal numbers. Share it only with
the staff who need it. The website never shows, logs or saves personal
numbers, and shows names only next to reviews (see below). The one exception
is the admin control panel, which shows logged-in admins every choice with
the person's name and personal number.

**Ratings and reviews** are saved in a tab called **ביקורות**, created with the
first review. Each person has one review per book; sending another replaces
it. The site shows the stars, text, date, writer's full name and מחזור to
everyone, but never the personal number. Reviews with an empty מחזור column
show no name. To take a review down, delete its row in the sheet. The מחזור
options are listed in `index.html` and in `COHORTS` at the top of `Code.gs`
(and in the demo server in `api.js`); keep them the same.

---

## 3. Update the books when the Excel file changes

1. Edit `books.xlsx` (keep the same column headers).
2. Run: `python convert.py`
3. Read the messages it prints:
   - `Warning … row skipped` – a row has no title or invalid years. Fix it in Excel.
   - `Note … not approved` – column "האם אושר?" isn't `1`, so the book is hidden.
   - `Note … no usable link` – there's no file for this book yet (see below).
4. If books were **added, removed or renamed**, copy the new
   `apps-script/Books.gs` into the Apps Script project and publish a new
   version (see "Changing the server code later" above). Otherwise the server
   will refuse choices for the new books.
5. Give the new `books.json` (and any new files in `Books/` or `covers/`) to
   whoever hosts the site.

Good to know:
- **Years column:** `מתאים לכולם` → all years, `כן, שנה ב'` → year ב'.
  You can also write `1,3` or `שנה ב' ו-ג'`.
- **Book ids never move.** A book keeps its id as long as its title stays the
  same, so saved choices stay correct. If you **rename** a book, it gets a new
  id, and old choices for it show in "הבחירות שלי" as "ספר שהוסר מהרשימה".
- **Adding a digital copy** (for example Nitzan's files): put the file in `Books/`,
  named with words from the title (e.g. `צבא וביטחון.pdf`), then run
  `convert.py`. If the name doesn't match, write the exact file name in the
  Excel column "עותק דיגיטלי/מיקום הספר". Web links (`https://…`) in that
  column also work. Links to `file:///C:/Users/...` are ignored, because they
  only work on one person's computer.
- **Adding a cover:** put a picture (jpg / png / webp) in `covers/`, named with
  words from the title (e.g. `המחקר המודיעיני.jpeg`), then run `convert.py`.
  Or add an Excel column named `כריכה` with the picture's file name.
  Books without a cover show as text only.

---

## 4. Files to give whoever hosts the site

The site is plain static files – any web host works.

**Upload these:**
```
index.html
style.css
script.js
api.js          (with API_URL filled in)
books.json
Books/          (the digital copies – about 160 MB; one PDF is 83 MB)
covers/
```

**Don't upload:** `books.xlsx`, `dummy-data.xlsx`, `convert.py`, `apps-script/`,
`README.md`, `presentation.pptx`, `main.html`.
