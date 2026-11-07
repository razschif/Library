/**
 * Code.gs - the server for "ספריית המודיעין".
 *
 * It runs on Google Apps Script, attached to a Google Sheet.
 * Every choice is saved as one row in the sheet tab "בחירות".
 *
 * The website talks to this script in two ways:
 *   GET  ...?action=counts       -> how many people chose each book (no names, no IDs)
 *   POST {action: "add", ...}    -> add a book to a person's choices
 *   POST {action: "remove", ...} -> remove a book from a person's choices
 *   POST {action: "mine", ...}   -> list the book ids a person chose
 *
 * The rules are checked HERE, on the server, so nobody can skip them
 * by changing the website code in their browser:
 *   - the name and the personal number (מספר אישי) must be valid
 *   - the book id must exist (see Books.gs, created by convert.py)
 *   - the same person can't choose the same book twice
 *   - a personal number always belongs to the same name
 *   - optional: a maximum number of books per person
 *
 * Every answer is JSON: {ok: true, ...} or {ok: false, error: "Hebrew message"}.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

var SHEET_NAME = 'בחירות';         // the sheet tab where choices are saved
var MAX_BOOKS_PER_PERSON = 0;      // 0 = no limit. For example 1 = one book per person.
var LOCK_WAIT_MS = 10000;          // how long to wait for other submissions to finish

// Column order in the sheet (1 = column A).
var HEADERS = ['זמן', 'מספר ספר', 'שם הספר', 'שם מלא', 'מספר אישי'];
var COL_BOOK_ID = 2;
var COL_NAME = 4;
var COL_PERSONAL_ID = 5;

// ---------------------------------------------------------------------------
// Entry points (Google calls these automatically)
// ---------------------------------------------------------------------------

/** Handles GET requests. Only returns public numbers, never personal details. */
function doGet(e) {
  var action = e && e.parameter ? e.parameter.action : '';
  if (action === 'counts') {
    return jsonResponse({ ok: true, counts: countChoicesPerBook() });
  }
  return jsonResponse({ ok: false, error: 'בקשה לא מוכרת.' });
}

/** Handles POST requests (add / remove / mine). */
function doPost(e) {
  var request;
  try {
    request = JSON.parse(e.postData.contents);
  } catch (error) {
    return jsonResponse({ ok: false, error: 'הבקשה לא תקינה.' });
  }

  var name = normalizeName(request.name);
  var personalId = String(request.id || '').replace(/\s/g, '');

  // Check the person's details before anything else.
  var detailsError = getNameError(name) || getPersonalIdError(personalId);
  if (detailsError) {
    return jsonResponse({ ok: false, error: detailsError });
  }

  if (request.action === 'mine') {
    return jsonResponse(getChoicesOf(name, personalId));
  }
  if (request.action === 'add' || request.action === 'remove') {
    var bookId = String(request.bookId);
    if (!BOOK_TITLES.hasOwnProperty(bookId)) {
      return jsonResponse({ ok: false, error: 'הספר לא נמצא ברשימה. רעננו את הדף ונסו שוב.' });
    }
    // Only one add/remove runs at a time, so two requests can't break the rules together.
    return jsonResponse(withLock(function () {
      return request.action === 'add'
        ? saveChoice(bookId, name, personalId)
        : deleteChoice(bookId, name, personalId);
    }));
  }
  return jsonResponse({ ok: false, error: 'בקשה לא מוכרת.' });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Saves a new choice, after checking all the rules. */
function saveChoice(bookId, name, personalId) {
  var rows = rowsOfPerson(personalId);

  var nameError = checkSameName(rows, name);
  if (nameError) return { ok: false, error: nameError };

  var alreadyChosen = rows.some(function (row) { return row.bookId === bookId; });
  if (alreadyChosen) {
    return { ok: false, error: 'כבר בחרת בספר הזה. הוא מופיע ב"הבחירות שלי".' };
  }

  if (MAX_BOOKS_PER_PERSON > 0 && rows.length >= MAX_BOOKS_PER_PERSON) {
    return { ok: false, error: 'אפשר לבחור עד ' + MAX_BOOKS_PER_PERSON +
      ' ספרים. כדי לבחור ספר אחר, הסירו קודם ספר מ"הבחירות שלי".' };
  }

  var sheet = getSheet();
  var newRow = sheet.getLastRow() + 1;
  var range = sheet.getRange(newRow, 1, 1, HEADERS.length);
  range.setNumberFormat('@'); // save everything as text, so "0123456" keeps its leading 0
  range.setValues([[new Date().toISOString(), bookId, BOOK_TITLES[bookId], name, personalId]]);
  return { ok: true };
}

/** Deletes one choice of this person. */
function deleteChoice(bookId, name, personalId) {
  var rows = rowsOfPerson(personalId);

  var nameError = checkSameName(rows, name);
  if (nameError) return { ok: false, error: nameError };

  var match = rows.filter(function (row) { return row.bookId === bookId; })[0];
  if (!match) {
    return { ok: false, error: 'הספר הזה לא נמצא בבחירות שלך.' };
  }
  getSheet().deleteRow(match.rowNumber);
  return { ok: true };
}

/** Returns the book ids that this person chose. */
function getChoicesOf(name, personalId) {
  var rows = rowsOfPerson(personalId);
  var nameError = checkSameName(rows, name);
  if (nameError) return { ok: false, error: nameError };
  return { ok: true, bookIds: rows.map(function (row) { return Number(row.bookId); }) };
}

/** Returns {bookId: numberOfPeople}. Contains no personal details. */
function countChoicesPerBook() {
  var counts = {};
  readAllRows().forEach(function (row) {
    counts[row.bookId] = (counts[row.bookId] || 0) + 1;
  });
  return counts;
}

// ---------------------------------------------------------------------------
// Validation (the website checks the same things, but the server must too)
// ---------------------------------------------------------------------------

/** Removes extra spaces, so "  ישראל   ישראלי " becomes "ישראל ישראלי". */
function normalizeName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

/** Returns an error message, or '' if the name is OK. */
function getNameError(name) {
  if (!name) return 'יש להזין שם מלא.';
  if (name.length > 60) return 'השם ארוך מדי.';
  if (name.split(' ').length < 2) return 'יש להזין שם פרטי ושם משפחה.';
  if (!/^[א-תA-Za-z\s'"׳״.\-]+$/.test(name)) {
    return 'השם יכול להכיל אותיות בלבד.';
  }
  return '';
}

/** Returns an error message, or '' if the personal number is 7 digits. */
function getPersonalIdError(personalId) {
  if (!personalId) return 'יש להזין מספר אישי.';
  if (!/^\d+$/.test(personalId)) return 'המספר האישי יכול להכיל ספרות בלבד.';
  if (personalId.length !== 7) return 'מספר אישי צריך להכיל בדיוק 7 ספרות.';
  return '';
}

/**
 * A personal number must always come with the same name.
 * This stops someone from seeing or changing another person's choices
 * just by typing their personal number.
 */
function checkSameName(rows, name) {
  if (rows.length > 0 && rows[0].name !== name) {
    return 'השם לא תואם לשם שנרשם עם המספר האישי הזה. ' +
      'יש להקליד את השם בדיוק כמו בפעם הראשונה.';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

/** Returns the "בחירות" sheet tab, creating it (with headers) if needed. */
function getSheet() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Reads every choice row as {rowNumber, bookId, name, personalId}. */
function readAllRows() {
  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getDisplayValues();
  return values.map(function (cells, index) {
    return {
      rowNumber: index + 2,
      bookId: String(cells[COL_BOOK_ID - 1]),
      name: normalizeName(cells[COL_NAME - 1]),
      personalId: String(cells[COL_PERSONAL_ID - 1])
    };
  });
}

/** Returns only the rows of one personal number. */
function rowsOfPerson(personalId) {
  return readAllRows().filter(function (row) { return row.personalId === personalId; });
}

/** Runs `work` while holding the lock, so only one change happens at a time. */
function withLock(work) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return { ok: false, error: 'השרת עמוס כרגע. נסו שוב בעוד רגע.' };
  }
  try {
    var result = work();
    SpreadsheetApp.flush(); // make sure the change is written before the lock is released
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** Turns an object into a JSON answer for the website. */
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
