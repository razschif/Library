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
 *   GET  ...?action=settings     -> the site settings (for now: show book covers or not)
 *   POST {action: "admin", ...}         -> ADMINS ONLY: every choice, with names and personal numbers
 *   POST {action: "adminSettings", ...} -> ADMINS ONLY: change the site settings
 *
 * Admins are listed in the sheet tab "מנהלים" (full name, personal number,
 * password). Run setUpAdminTabs() once from the editor to create it.
 *
 * The rules are checked HERE, on the server, so nobody can skip them
 * by changing the website code in their browser:
 *   - the name and the personal number (מספר אישי) must be valid
 *   - the book id must exist (see Books.gs, created by convert.py)
 *   - the same person can't choose the same book twice
 *   - a personal number always belongs to the same name
 *   - optional: a maximum number of books per person
 *   - a person's first choice must include their מחזור, and a מחלקה too
 *     (except סגל). Later choices reuse them.
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
var HEADERS = ['זמן', 'מספר ספר', 'שם הספר', 'שם מלא', 'מספר אישי', 'מחזור', 'מחלקה'];
var COL_BOOK_ID = 2;
var COL_NAME = 4;
var COL_PERSONAL_ID = 5;
var COL_CHOICE_COHORT = 6;
var COL_CHOICE_DEPARTMENT = 7;

// The מחלקה options (keep the same as index.html and api.js).
// Every מחזור has these, except the ones in COHORTS_WITHOUT_DEPARTMENT.
var DEPARTMENTS = ['1', '2', '3'];
var COHORTS_WITHOUT_DEPARTMENT = ['סגל'];

// Reviews are saved in their own sheet tab. The first columns match the choices tab.
var REVIEWS_SHEET_NAME = 'ביקורות';
var MAX_REVIEW_LENGTH = 1000;      // characters
var COHORTS = ['כ', 'כ"א', 'כ"ב', 'סגל']; // the מחזור options (keep the same as index.html)
var REVIEW_HEADERS = ['זמן', 'מספר ספר', 'שם הספר', 'שם מלא', 'מספר אישי', 'דירוג', 'ביקורת', 'מחזור'];
var COL_TIME = 1;
var COL_RATING = 6;
var COL_REVIEW_TEXT = 7;
var COL_COHORT = 8;

// Admins: one row per admin. Only people in this tab can open the control panel.
var ADMINS_SHEET_NAME = 'מנהלים';
var ADMIN_HEADERS = ['שם מלא', 'מספר אישי', 'סיסמה'];
var MAX_ADMIN_FAILURES = 5;        // wrong logins in a row before a personal number is blocked
var ADMIN_BLOCK_SECONDS = 15 * 60; // how long it stays blocked

// Site settings that admins change from the control panel.
var SETTINGS_SHEET_NAME = 'הגדרות';
var SETTINGS_HEADERS = ['הגדרה', 'ערך'];
var SETTING_SHOW_COVERS = 'הצגת כריכות';

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
  if (action === 'settings') {
    return jsonResponse({ ok: true, settings: readSettings() });
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

  if (request.action === 'admin' || request.action === 'adminSettings') {
    var adminError = checkAdmin(name, personalId, request.password);
    if (adminError) return jsonResponse({ ok: false, error: adminError });
    if (request.action === 'adminSettings') {
      return jsonResponse(withLock(function () {
        return saveSettings(request.settings || {});
      }));
    }
    return jsonResponse({ ok: true, settings: readSettings(), choices: getAllChoicesForAdmin() });
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
        ? saveChoice(bookId, name, personalId, String(request.cohort || ''), String(request.department || ''))
        : deleteChoice(bookId, name, personalId);
    }));
  }
  return jsonResponse({ ok: false, error: 'בקשה לא מוכרת.' });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Saves a new choice, after checking all the rules.
 * cohort and department are needed only for a person's first choice.
 */
function saveChoice(bookId, name, personalId, cohort, department) {
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

  var profile = profileOf(rows);
  if (!profile) {
    // First choice: the site must send the מחזור and מחלקה.
    if (!cohort) {
      return { ok: false, needProfile: true, error: 'זו הבחירה הראשונה שלך. יש לבחור מחזור ומחלקה.' };
    }
    var profileError = getCohortError(cohort) || getDepartmentError(cohort, department);
    if (profileError) return { ok: false, needProfile: true, error: profileError };
    profile = { cohort: cohort, department: needsDepartment(cohort) ? department : '' };
  }

  var sheet = getSheet();
  fillMissingHeaders(sheet, HEADERS);
  var newRow = nextFreeRow(sheet, 1);
  var range = sheet.getRange(newRow, 1, 1, HEADERS.length);
  range.setNumberFormat('@'); // save everything as text, so "0123456" keeps its leading 0
  range.setValues([[new Date().toISOString(), bookId, BOOK_TITLES[bookId], name, personalId,
    profile.cohort, profile.department]]);
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

/**
 * Returns {cohort, department} from a person's earlier choices, or null if
 * none of them has a מחזור (a new person, or choices made before this was asked).
 */
function profileOf(rows) {
  var withCohort = rows.filter(function (row) { return row.cohort; })[0];
  return withCohort ? { cohort: withCohort.cohort, department: withCohort.department } : null;
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
// Admins and settings
// ---------------------------------------------------------------------------

/**
 * Run this ONCE from the Apps Script editor (choose it in the list at the top,
 * then click Run). It creates the "מנהלים" and "הגדרות" tabs. Then type each
 * admin's full name, personal number and a password into "מנהלים".
 */
function setUpAdminTabs() {
  var admins = getOrCreateSheet(ADMINS_SHEET_NAME, ADMIN_HEADERS);
  admins.getRange('A:C').setNumberFormat('@'); // keeps leading zeros in personal numbers
  getOrCreateSheet(SETTINGS_SHEET_NAME, SETTINGS_HEADERS);
  Logger.log('Done. Add admins to the "' + ADMINS_SHEET_NAME + '" tab.');
}

/**
 * Returns '' if this person is an admin with the right password, or an error.
 * The error never says which detail was wrong, and after too many wrong tries
 * the personal number is blocked for a while, so passwords can't be guessed.
 */
function checkAdmin(name, personalId, password) {
  var cache = CacheService.getScriptCache();
  var failKey = 'admin-fail-' + personalId;
  var failures = Number(cache.get(failKey) || 0);
  if (failures >= MAX_ADMIN_FAILURES) {
    return 'יותר מדי ניסיונות כניסה שגויים. נסו שוב בעוד 15 דקות.';
  }
  password = String(password || '');
  var match = password && readAdmins().some(function (admin) {
    return admin.personalId === personalId && admin.name === name && admin.password === password;
  });
  if (!match) {
    cache.put(failKey, String(failures + 1), ADMIN_BLOCK_SECONDS);
    return 'פרטי הכניסה שגויים, או שאין לך הרשאת מנהל.';
  }
  cache.remove(failKey);
  return '';
}

/** Reads the admins tab as [{name, personalId, password}]. */
function readAdmins() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ADMINS_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, ADMIN_HEADERS.length).getDisplayValues()
    .map(function (cells) {
      var id = String(cells[1]).replace(/\s/g, '');
      // If the cell was typed as a number, the sheet drops leading zeros. Put them back.
      if (/^\d{1,6}$/.test(id)) id = ('0000000' + id).slice(-7);
      return { name: normalizeName(cells[0]), personalId: id, password: String(cells[2]) };
    })
    .filter(function (admin) { return admin.name && admin.personalId && admin.password; });
}

/** Every choice, newest first, for the admin control panel only. */
function getAllChoicesForAdmin() {
  var sheet = getSheet();
  if (sheet.getLastRow() < 2) return [];
  var choices = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getDisplayValues()
    .map(function (cells) {
      return {
        date: String(cells[0]),
        bookId: Number(cells[COL_BOOK_ID - 1]),
        title: String(cells[2]),
        name: normalizeName(cells[COL_NAME - 1]),
        personalId: String(cells[COL_PERSONAL_ID - 1]),
        cohort: String(cells[COL_CHOICE_COHORT - 1]),
        department: String(cells[COL_CHOICE_DEPARTMENT - 1])
      };
    })
    .filter(function (choice) { return choice.name; });
  // Rows saved before מחזור was asked get it from the same person's newer rows.
  var profiles = {};
  choices.forEach(function (choice) {
    if (choice.cohort && !profiles[choice.personalId]) {
      profiles[choice.personalId] = { cohort: choice.cohort, department: choice.department };
    }
  });
  choices.forEach(function (choice) {
    var profile = profiles[choice.personalId];
    if (!choice.cohort && profile) {
      choice.cohort = profile.cohort;
      choice.department = profile.department;
    }
  });
  return choices.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
}

/** Returns the public site settings: {showCovers: true/false}. */
function readSettings() {
  var values = {};
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTINGS_SHEET_NAME);
  if (sheet && sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues().forEach(function (cells) {
      values[String(cells[0]).trim()] = String(cells[1]).trim();
    });
  }
  return { showCovers: isYes(values[SETTING_SHOW_COVERS]) };
}

/** "כן", "TRUE", "1" ... count as yes. Anything else (or empty) is no. */
function isYes(value) {
  return ['כן', 'true', '1', 'yes', 'v', '✓'].indexOf(String(value || '').toLowerCase()) !== -1;
}

/** Saves the settings an admin changed, and returns the new settings. */
function saveSettings(settings) {
  if (typeof settings.showCovers === 'boolean') {
    writeSetting(SETTING_SHOW_COVERS, settings.showCovers ? 'כן' : 'לא');
  }
  return { ok: true, settings: readSettings() };
}

/** Writes one setting, updating its row or adding a new one. */
function writeSetting(key, value) {
  var sheet = getOrCreateSheet(SETTINGS_SHEET_NAME, SETTINGS_HEADERS);
  var rowNumber = 0;
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues().forEach(function (cells, index) {
      if (String(cells[0]).trim() === key) rowNumber = index + 2;
    });
  }
  if (!rowNumber) rowNumber = nextFreeRow(sheet, 1);
  var range = sheet.getRange(rowNumber, 1, 1, 2);
  range.setNumberFormat('@');
  range.setValues([[key, value]]);
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

/** True if this מחזור is split into מחלקות. */
function needsDepartment(cohort) {
  return COHORTS_WITHOUT_DEPARTMENT.indexOf(cohort) === -1;
}

/** Returns an error message, or '' if the מחלקה fits the מחזור. */
function getDepartmentError(cohort, department) {
  if (!needsDepartment(cohort)) return '';
  return DEPARTMENTS.indexOf(department) === -1 ? 'יש לבחור מחלקה.' : '';
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

/** Adds header names for columns that were added after the tab was created. */
function fillMissingHeaders(sheet, headers) {
  var range = sheet.getRange(1, 1, 1, headers.length);
  var current = range.getDisplayValues()[0];
  var changed = false;
  var filled = current.map(function (cell, index) {
    if (cell) return cell;
    changed = true;
    return headers[index];
  });
  if (changed) range.setValues([filled]);
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

/** Reads every choice row as {rowNumber, bookId, name, personalId, cohort, department}. */
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
      personalId: String(cells[COL_PERSONAL_ID - 1]),
      cohort: String(cells[COL_CHOICE_COHORT - 1]),
      department: String(cells[COL_CHOICE_DEPARTMENT - 1])
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
