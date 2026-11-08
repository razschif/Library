/**
 * DummyData.gs - sample reviews and choices for trying out the site.
 *
 * In the Apps Script editor, pick a function from the list at the top and
 * click Run. No new deployment is needed.
 *   addDummyData     -> adds the sample rows (running it again replaces them)
 *   removeDummyData  -> removes the sample rows and nothing else
 *
 * Sample people have made-up surnames and personal numbers starting with 00000,
 * so real people's rows are never touched.
 */

var DUMMY_PEOPLE = [
  ['נועה לדוגמה', 'כ'], ['איתי הדגמה', 'כ'], ['מאיה בדיקה', 'כ'],
  ['יונתן לדוגמה', 'כ'], ['תמר הדגמה', 'כ"א'], ['עומר בדיקה', 'כ"א'],
  ['שירה לדוגמה', 'כ"א'], ['דניאל הדגמה', 'כ"א'], ['רוני בדיקה', 'כ"ב'],
  ['אורי לדוגמה', 'כ"ב'], ['ליאור הדגמה', 'כ"ב'], ['גיל בדיקה', 'כ"ב'],
  ['מיכל לדוגמה', 'סגל'], ['אבי הדגמה', 'סגל']
];
var DUMMY_REVIEWS_PER_PERSON = 6;
var DUMMY_CHOICES_PER_PERSON = 3;
var DUMMY_DAYS_BACK = 45;              // reviews are dated within this many days

var DUMMY_RATINGS = [1, 2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5]; // mostly good, a few bad

// An empty text is a rating without a written review.
var DUMMY_TEXTS = {
  1: ['לא הצלחתי להתחבר לספר ועזבתי אחרי כמה פרקים.', 'קשה לקריאה ולא תרם לי הרבה.'],
  2: ['יש כמה רעיונות טובים, אבל הם הולכים לאיבוד באריכות.', 'ציפיתי ליותר עומק.', ''],
  3: ['ספר סביר. החלק הראשון חזק יותר מהשני.', 'מעניין, אבל לא חובה.', ''],
  4: ['ספר טוב שגרם לי לחשוב אחרת על התפקיד.', 'כתוב היטב ורלוונטי לעבודה שלנו.',
      'לקח לי זמן להיכנס אליו, אבל היה שווה את זה.', ''],
  5: ['אחד הספרים הטובים שקראתי השנה. ממליץ בחום.', 'חובה לכל מי שעוסק במודיעין.',
      'קראתי בנשימה אחת.\nחזרתי לכמה פרקים גם אחר כך.', '']
};

/** Adds the sample rows. Running it again replaces them instead of doubling them. */
function addDummyData() {
  var result = withLock(function () {
    removeDummyRows();
    var data = buildDummyRows();
    appendDummyRows(getOrCreateSheet(REVIEWS_SHEET_NAME, REVIEW_HEADERS), data.reviews);
    appendDummyRows(getSheet(), data.choices);
    return { ok: true, reviews: data.reviews.length, choices: data.choices.length };
  });
  Logger.log(result);
}

/** Removes only the sample rows. */
function removeDummyData() {
  Logger.log(withLock(function () {
    return { ok: true, removed: removeDummyRows() };
  }));
}

/** Returns the sample people as {name, id, cohort}. */
function dummyPeople() {
  return DUMMY_PEOPLE.map(function (person, index) {
    return { name: person[0], cohort: person[1], id: ('000000' + (index + 1)).slice(-7) };
  });
}

/** Builds rows in the same column order as the real tabs. Same books every run. */
function buildDummyRows() {
  var seed = 20261108;
  var random = function (limit) {
    seed = (seed * 16807) % 2147483647;
    return seed % limit;
  };
  var pick = function (list) { return list[random(list.length)]; };
  var now = Date.now();
  var recentTime = function () {
    return new Date(now - random(DUMMY_DAYS_BACK * 24 * 60) * 60000).toISOString();
  };

  var reviews = [];
  var choices = [];
  dummyPeople().forEach(function (person) {
    var bookIds = Object.keys(BOOK_TITLES);
    for (var i = bookIds.length - 1; i > 0; i--) { // shuffle, so no book repeats for a person
      var j = random(i + 1);
      var swap = bookIds[i]; bookIds[i] = bookIds[j]; bookIds[j] = swap;
    }
    bookIds.slice(0, DUMMY_REVIEWS_PER_PERSON).forEach(function (bookId) {
      var rating = pick(DUMMY_RATINGS);
      reviews.push([recentTime(), bookId, BOOK_TITLES[bookId], person.name, person.id,
        String(rating), pick(DUMMY_TEXTS[rating]), person.cohort]);
    });
    bookIds.slice(0, DUMMY_CHOICES_PER_PERSON).forEach(function (bookId) {
      choices.push([recentTime(), bookId, BOOK_TITLES[bookId], person.name, person.id]);
    });
  });
  return { reviews: reviews, choices: choices };
}

function appendDummyRows(sheet, rows) {
  var range = sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length);
  range.setNumberFormat('@'); // keeps the leading zeros of the personal numbers
  range.setValues(rows);
}

/** Deletes every sample row from both tabs and returns how many there were. */
function removeDummyRows() {
  var names = {};
  dummyPeople().forEach(function (person) { names[person.id] = person.name; });
  var isDummy = function (row) { return names[row.personalId] === row.name; };

  var removed = deleteRows(getSheet(), readAllRows().filter(isDummy));
  var reviewRows = readAllReviews().filter(isDummy);
  if (reviewRows.length > 0) {
    removed += deleteRows(getOrCreateSheet(REVIEWS_SHEET_NAME, REVIEW_HEADERS), reviewRows);
  }
  return removed;
}

/** Deletes from the bottom up, so the remaining row numbers stay correct. */
function deleteRows(sheet, rows) {
  rows
    .map(function (row) { return row.rowNumber; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (rowNumber) { sheet.deleteRow(rowNumber); });
  return rows.length;
}
