/**
 * Code.gs - the server for "ספריית המודיעין".
 *
 * It runs on Google Apps Script, attached to a Google Sheet.
 * Every choice is saved as one row in the sheet tab "בחירות".
 *
 * The website talks to this script in two ways:
 *   GET  ...?action=counts       -> how many people chose each book (no names, no IDs)
 *   GET  ...?action=reviews      -> each book's reviews with the writer's name and מחזור (never personal numbers)
 *   POST {action: "review", ...} -> save a person's rating and review of a book
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

// Reviews are saved in their own sheet tab. The first columns match the choices tab.
var REVIEWS_SHEET_NAME = 'ביקורות';
var MAX_REVIEW_LENGTH = 1000;      // characters
var COHORTS = ['כ', 'כ"א', 'כ"ב', 'סגל']; // the מחזור options (keep the same as index.html)
var REVIEW_HEADERS = ['זמן', 'מספר ספר', 'שם הספר', 'שם מלא', 'מספר אישי', 'דירוג', 'ביקורת', 'מחזור'];
var COL_TIME = 1;
var COL_RATING = 6;
var COL_REVIEW_TEXT = 7;
var COL_COHORT = 8;

// ---------------------------------------------------------------------------
// Entry points (Google calls these automatically)
// ---------------------------------------------------------------------------

/** Handles GET requests. Only returns public numbers, never personal details. */
function doGet(e) {
  var action = e && e.parameter ? e.parameter.action : '';
  if (action === 'counts') {
    return jsonResponse({ ok: true, counts: countChoicesPerBook() });
  }
  if (action === 'reviews') {
    return jsonResponse({ ok: true, reviews: getPublicReviews() });
  }
  return jsonResponse({ ok: false, error: 'בקשה לא מוכרת.' });
}

/** Handles POST requests (add / remove / mine / review). */
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
  if (request.action === 'add' || request.action === 'remove' || request.action === 'review') {
    var bookId = String(request.bookId);
    if (!BOOK_TITLES.hasOwnProperty(bookId)) {
      return jsonResponse({ ok: false, error: 'הספר לא נמצא ברשימה. רעננו את הדף ונסו שוב.' });
    }
    if (request.action === 'review') {
      var rating = Number(request.rating);
      var text = normalizeReviewText(request.text);
      var cohort = String(request.cohort || '');
      var reviewError = getRatingError(rating) || getReviewTextError(text) || getCohortError(cohort);
      if (reviewError) {
        return jsonResponse({ ok: false, error: reviewError });
      }
      return jsonResponse(withLock(function () {
        return saveReview(bookId, name, personalId, rating, text, cohort);
      }));
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

  var nameError = checkSameName(rows.concat(reviewsOfPerson(personalId)), name);
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
  var newRow = nextFreeRow(sheet, 1);
  var range = sheet.getRange(newRow, 1, 1, HEADERS.length);
  range.setNumberFormat('@'); // save everything as text, so "0123456" keeps its leading 0
  range.setValues([[new Date().toISOString(), bookId, BOOK_TITLES[bookId], name, personalId]]);
  return { ok: true };
}

/** Deletes one choice of this person. */
function deleteChoice(bookId, name, personalId) {
  var rows = rowsOfPerson(personalId);

  var nameError = checkSameName(rows.concat(reviewsOfPerson(personalId)), name);
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
  var nameError = checkSameName(rows.concat(reviewsOfPerson(personalId)), name);
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

/** Saves this person's review of a book. A second review replaces the first. */
function saveReview(bookId, name, personalId, rating, text, cohort) {
  var reviews = reviewsOfPerson(personalId);

  var nameError = checkSameName(rowsOfPerson(personalId).concat(reviews), name);
  if (nameError) return { ok: false, error: nameError };

  var existing = reviews.filter(function (row) { return row.bookId === bookId; })[0];
  var sheet = getOrCreateSheet(REVIEWS_SHEET_NAME, REVIEW_HEADERS);
  var rowNumber = existing ? existing.rowNumber : nextFreeRow(sheet, 1);
  var range = sheet.getRange(rowNumber, 1, 1, REVIEW_HEADERS.length);
  range.setNumberFormat('@'); // text only, so a review starting with "=" is never run as a formula
  range.setValues([[new Date().toISOString(), bookId, BOOK_TITLES[bookId], name, personalId, String(rating), text, cohort]]);
  return { ok: true, updated: Boolean(existing) };
}

/**
 * Returns {bookId: [{rating, text, date, name, cohort}, ...]}, newest first.
 * Never includes personal numbers. Reviews with no מחזור were written when
 * reviews were promised to be anonymous, so their names stay hidden.
 */
function getPublicReviews() {
  var reviews = {};
  readAllReviews()
    .sort(function (a, b) { return a.date < b.date ? 1 : -1; })
    .forEach(function (row) {
      if (!reviews[row.bookId]) reviews[row.bookId] = [];
      reviews[row.bookId].push({
        rating: row.rating,
        text: row.text,
        date: row.date,
        name: row.cohort ? row.name : '',
        cohort: row.cohort
      });
    });
  return reviews;
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

/** Returns the review text with unified line breaks and no spaces around it. */
function normalizeReviewText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').trim();
}

/** Returns an error message, or '' if the rating is a whole number from 1 to 5. */
function getRatingError(rating) {
  return [1, 2, 3, 4, 5].indexOf(rating) === -1 ? 'יש לבחור דירוג של 1 עד 5 כוכבים.' : '';
}

/** Returns an error message, or '' if the review text is OK. It may be empty. */
function getReviewTextError(text) {
  return text.length > MAX_REVIEW_LENGTH ? 'הביקורת ארוכה מדי.' : '';
}

/** Returns an error message, or '' if the מחזור is one of the options. */
function getCohortError(cohort) {
  return COHORTS.indexOf(cohort) === -1 ? 'יש לבחור מחזור.' : '';
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
  return getOrCreateSheet(SHEET_NAME, HEADERS);
}

/** Returns a sheet tab by name, creating it (with headers) if needed. */
function getOrCreateSheet(sheetName, headers) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Returns the first empty row, adding rows if the tab is too short for `count`
 * more. Writing past the end of a tab fails, and imported tabs have no spare rows.
 */
function nextFreeRow(sheet, count) {
  var firstRow = sheet.getLastRow() + 1;
  var missing = firstRow + count - 1 - sheet.getMaxRows();
  if (missing > 0) sheet.insertRowsAfter(sheet.getMaxRows(), missing);
  return firstRow;
}

/** Reads every review row. Doesn't create the tab, so reading stays safe without the lock. */
function readAllReviews() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REVIEWS_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, REVIEW_HEADERS.length).getDisplayValues();
  return values.map(function (cells, index) {
    return {
      rowNumber: index + 2,
      date: String(cells[COL_TIME - 1]),
      bookId: String(cells[COL_BOOK_ID - 1]),
      name: normalizeName(cells[COL_NAME - 1]),
      personalId: String(cells[COL_PERSONAL_ID - 1]),
      rating: Number(cells[COL_RATING - 1]),
      text: String(cells[COL_REVIEW_TEXT - 1]),
      cohort: String(cells[COL_COHORT - 1])
    };
  });
}

/** Returns only the reviews written with one personal number. */
function reviewsOfPerson(personalId) {
  return readAllReviews().filter(function (row) { return row.personalId === personalId; });
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
