/*
 * script.js - everything the page does: loading the books, filters, sorting,
 * the book cards and the two pop-ups.
 *
 * Talking to the server happens ONLY through api.js:
 *   submitChoice, removeChoice, getMyChoices, getBookCounts, isDemoMode
 *
 * PRIVACY: names and personal numbers are read from the form, sent to api.js
 * and then cleared. They are never printed to the console, shown on the page
 * or saved in the browser.
 */

// ---------------------------------------------------------------------------
// Settings and page state
// ---------------------------------------------------------------------------

const BOOKS_FILE = "books.json";
const YEAR_LABELS = { 1: "שנה א'", 2: "שנה ב'", 3: "שנה ג'" };
const MAX_PERSON_ICONS = 5; // how many little person icons to show on a card
const SHOW_BOOK_COVERS = false; // set to false to hide all book covers

// Compares Hebrew (and English) text the way a Hebrew reader expects.
const hebrewCollator = new Intl.Collator("he", { sensitivity: "base", numeric: true });

let allBooks = [];      // every book from books.json
let bookCounts = {};    // {bookId: how many people chose it}
let currentBook = null; // the book whose "choose" pop-up is open

// Shortcut for finding elements by id.
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", init);

async function init() {
  $("demo-banner").hidden = !isDemoMode();
  setUpControls();
  setUpChooseDialog();
  setUpMineDialog();

  try {
    allBooks = await loadBooks();
  } catch (error) {
    showLoadError();
    return;
  }
  fillSubjectOptions(allBooks);
  renderBooks();
  refreshCounts();
}

/** Downloads books.json and returns the list of books. */
async function loadBooks() {
  const response = await fetch(BOOKS_FILE);
  if (!response.ok) throw new Error("Could not load " + BOOKS_FILE);
  return response.json();
}

function showLoadError() {
  $("results-count").textContent =
    "לא הצלחנו לטעון את רשימת הספרים. נסו לרענן את הדף.";
}

// ---------------------------------------------------------------------------
// Filters and sorting
// ---------------------------------------------------------------------------

/** Re-draw the books whenever a filter or the sort order changes. */
function setUpControls() {
  $("subject-filter").addEventListener("change", renderBooks);
  $("sort-select").addEventListener("change", renderBooks);
  getYearCheckboxes().forEach((box) => box.addEventListener("change", renderBooks));
}

function getYearCheckboxes() {
  return document.querySelectorAll("#year-filter input[type=checkbox]");
}

/** Adds one <option> per subject, sorted alphabetically. */
function fillSubjectOptions(books) {
  const subjects = [...new Set(books.map((book) => book.subject).filter(Boolean))];
  subjects.sort(hebrewCollator.compare);
  for (const subject of subjects) {
    $("subject-filter").append(new Option(subject, subject));
  }
}

/** Returns the year numbers whose checkbox is checked, e.g. [1, 3]. */
function getCheckedYears() {
  return [...getYearCheckboxes()].filter((box) => box.checked).map((box) => Number(box.value));
}

/** Keeps the books that match the chosen subject AND any checked year. */
function filterBooks(books) {
  const subject = $("subject-filter").value;
  const years = getCheckedYears();
  return books.filter((book) =>
    (subject === "all" || book.subject === subject) &&
    book.years.some((year) => years.includes(year))
  );
}

/** Compares two books by title (Hebrew-aware). */
function compareByName(a, b) {
  return hebrewCollator.compare(a.title, b.title);
}

/** Compares two books by the lowest year they are relevant for. Ties: by name. */
function compareByYear(a, b) {
  return Math.min(...a.years) - Math.min(...b.years) || compareByName(a, b);
}

/** Returns a sorted copy of the books, by the option chosen in the sort menu. */
function sortBooks(books) {
  const sorted = [...books];
  switch ($("sort-select").value) {
    case "name-asc":  return sorted.sort(compareByName);
    case "name-desc": return sorted.sort((a, b) => compareByName(b, a));
    case "year-asc":  return sorted.sort(compareByYear);
    // High -> low by year, but ties still go by name א -> ת.
    case "year-desc": return sorted.sort((a, b) =>
      Math.min(...b.years) - Math.min(...a.years) || compareByName(a, b));
    default:          return sorted;
  }
}

// ---------------------------------------------------------------------------
// Book cards
// ---------------------------------------------------------------------------

/** Filters, sorts and draws all the book cards. */
function renderBooks() {
  const books = sortBooks(filterBooks(allBooks));
  $("book-list").replaceChildren(...books.map(createBookCard));
  showResultsCount(books.length);
}

function showResultsCount(count) {
  let message;
  if (getCheckedYears().length === 0) message = "יש לסמן לפחות שנה אחת.";
  else if (count === 0) message = "לא נמצאו ספרים שמתאימים לסינון.";
  else if (count === 1) message = "מוצג ספר אחד";
  else message = `מוצגים ${count} ספרים`;
  $("results-count").textContent = message;
}

/** Builds one card from the <template> in index.html. */
function createBookCard(book) {
  const card = $("book-card-template").content.firstElementChild.cloneNode(true);
  const find = (selector) => card.querySelector(selector);

  card.dataset.bookId = book.id;
  find(".book-subject").textContent = book.subject;
  find(".book-title").textContent = book.title;
  find(".book-author").textContent = book.author;
  find(".book-description").textContent = book.description;
  fillYears(find(".book-years"), book.years);
  fillLink(find(".book-link"), book.link);
  fillCover(find(".book-cover"), book, card);
  fillCount(find(".book-count"), bookCounts[book.id] || 0);
  find(".choose-btn").addEventListener("click", () => openChooseDialog(book));
  return card;
}

function fillYears(list, years) {
  for (const year of years) {
    const item = document.createElement("li");
    item.textContent = YEAR_LABELS[year] || `שנה ${year}`;
    list.append(item);
  }
}

function fillLink(link, url) {
  if (!url) return;
  link.href = url;
  link.hidden = false;
}

function fillCover(img, book, card) {
  if (!SHOW_BOOK_COVERS || !book.cover) return;
  img.src = book.cover;
  img.alt = "כריכת הספר " + book.title;
  img.hidden = false;
  card.classList.add("has-cover");
}

/** Shows "how many people chose this book" with small person icons. */
function fillCount(element, count) {
  element.replaceChildren();
  if (count === 0) {
    element.textContent = "עוד לא נבחר";
    return;
  }
  const icons = document.createElement("span");
  icons.className = "person-icons";
  icons.setAttribute("aria-hidden", "true");
  for (let i = 0; i < Math.min(count, MAX_PERSON_ICONS); i++) {
    icons.append(createPersonIcon());
  }
  const text = count === 1 ? "בחירה אחת" : `${count} בחרו`;
  element.append(icons, document.createTextNode(text));
}

/** A small "person" drawing (SVG). */
function createPersonIcon() {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "person-icon");
  const head = document.createElementNS(svgNS, "circle");
  head.setAttribute("cx", "8");
  head.setAttribute("cy", "5");
  head.setAttribute("r", "3");
  const body = document.createElementNS(svgNS, "path");
  body.setAttribute("d", "M2 15c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5z");
  svg.append(head, body);
  return svg;
}

/** Downloads the latest counts and updates the cards (without re-drawing them). */
async function refreshCounts() {
  const result = await getBookCounts();
  if (!result.ok) return; // counts are a nice extra; the site works without them
  bookCounts = result.counts || {};
  for (const card of document.querySelectorAll(".book-card")) {
    fillCount(card.querySelector(".book-count"), bookCounts[card.dataset.bookId] || 0);
  }
}

// ---------------------------------------------------------------------------
// Form validation (the server checks the same rules again)
// ---------------------------------------------------------------------------

/** "  ישראל   ישראלי " -> "ישראל ישראלי" */
function cleanName(name) {
  return name.replace(/\s+/g, " ").trim();
}

/** Removes spaces, so "123 4567" is accepted as "1234567". */
function cleanPersonalId(id) {
  return id.replace(/\s/g, "");
}

/** Returns a Hebrew error message, or "" if the name is OK. */
function validateName(rawName) {
  const name = cleanName(rawName);
  if (!name) return "יש להזין שם מלא.";
  if (name.split(" ").length < 2) return "יש להזין שם פרטי ושם משפחה.";
  if (!/^[א-תA-Za-z\s'"׳״.\-]+$/.test(name)) return "השם יכול להכיל אותיות בלבד.";
  return "";
}

/** Returns a Hebrew error message, or "" if the personal number is 7 digits. */
function validatePersonalId(rawId) {
  const id = cleanPersonalId(rawId);
  if (!id) return "יש להזין מספר אישי.";
  if (!/^\d+$/.test(id)) return "המספר האישי יכול להכיל ספרות בלבד.";
  if (id.length !== 7) return `מספר אישי צריך להכיל בדיוק 7 ספרות (הוזנו ${id.length}).`;
  return "";
}

/** Shows (or clears) the error under one input. Returns true if there is no error. */
function showFieldError(input, errorElement, message) {
  errorElement.textContent = message;
  input.setAttribute("aria-invalid", message ? "true" : "false");
  return !message;
}

/** Checks a name + personal-number pair of inputs. Focuses the first wrong one. */
function validateIdentityFields(prefix) {
  const nameInput = $(`${prefix}-name`);
  const idInput = $(`${prefix}-id`);
  const nameOk = showFieldError(nameInput, $(`${prefix}-name-error`), validateName(nameInput.value));
  const idOk = showFieldError(idInput, $(`${prefix}-id-error`), validatePersonalId(idInput.value));
  if (!nameOk) nameInput.focus();
  else if (!idOk) idInput.focus();
  return nameOk && idOk;
}

/** Clears a field's error as soon as the user starts fixing it. */
function clearErrorWhileTyping(prefix) {
  for (const field of ["name", "id"]) {
    $(`${prefix}-${field}`).addEventListener("input", () =>
      showFieldError($(`${prefix}-${field}`), $(`${prefix}-${field}-error`), ""));
  }
}

/** Shows a general error (for example from the server) at the bottom of a form. */
function showFormError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

/** Disables a button and changes its text while waiting for the server. */
function setBusy(button, busy, busyText) {
  if (busy) button.dataset.text = button.textContent;
  button.textContent = busy ? busyText : button.dataset.text;
  button.disabled = busy;
}

/** Every button with data-close closes the pop-up it is in. */
function setUpCloseButtons(dialog) {
  dialog.querySelectorAll("[data-close]").forEach((button) =>
    button.addEventListener("click", () => dialog.close()));
}

// ---------------------------------------------------------------------------
// Pop-up: choose a book
// ---------------------------------------------------------------------------

function setUpChooseDialog() {
  const dialog = $("choose-dialog");
  setUpCloseButtons(dialog);
  clearErrorWhileTyping("choose");
  $("choose-form").addEventListener("submit", handleChooseSubmit);
  // The "close" event arrives a moment after closing. If the pop-up was already
  // opened again by then, don't reset it.
  dialog.addEventListener("close", () => { if (!dialog.open) resetChooseDialog(); });
}

function openChooseDialog(book) {
  resetChooseDialog();
  currentBook = book;
  $("choose-book-title").textContent = book.title;
  $("choose-dialog").showModal();
  $("choose-name").focus();
}

async function handleChooseSubmit(event) {
  event.preventDefault();
  showFormError($("choose-error"), "");
  if (!validateIdentityFields("choose")) return;

  const button = $("choose-submit");
  setBusy(button, true, "שומר…");
  const result = await submitChoice(
    currentBook.id,
    cleanName($("choose-name").value),
    cleanPersonalId($("choose-id").value)
  );
  setBusy(button, false);

  if (!result.ok) {
    showFormError($("choose-error"), result.error || "אירעה שגיאה. נסו שוב.");
    return;
  }
  showChooseSuccess();
  refreshCounts();
}

function showChooseSuccess() {
  $("choose-form").reset(); // forget the name and number right away
  $("success-book-title").textContent = currentBook.title;
  $("choose-form").hidden = true;
  $("choose-success").hidden = false;
  $("choose-success").querySelector("button").focus();
}

/** Runs every time the pop-up closes: back to an empty form. */
function resetChooseDialog() {
  $("choose-form").reset();
  for (const field of ["name", "id"]) {
    showFieldError($(`choose-${field}`), $(`choose-${field}-error`), "");
  }
  showFormError($("choose-error"), "");
  $("choose-form").hidden = false;
  $("choose-success").hidden = true;
  currentBook = null;
}

// ---------------------------------------------------------------------------
// Pop-up: my choices
// ---------------------------------------------------------------------------

// While this pop-up is open we keep the person's details here, so the
// "remove" buttons can use them. They are erased when the pop-up closes.
let mineIdentity = null;

function setUpMineDialog() {
  const dialog = $("mine-dialog");
  setUpCloseButtons(dialog);
  clearErrorWhileTyping("mine");
  $("my-choices-btn").addEventListener("click", () => {
    resetMineDialog();
    dialog.showModal();
    $("mine-name").focus();
  });
  $("mine-form").addEventListener("submit", handleMineSubmit);
  dialog.addEventListener("close", () => { if (!dialog.open) resetMineDialog(); });
}

async function handleMineSubmit(event) {
  event.preventDefault();
  showFormError($("mine-error"), "");
  if (!validateIdentityFields("mine")) return;

  const identity = {
    name: cleanName($("mine-name").value),
    id: cleanPersonalId($("mine-id").value),
  };
  const button = $("mine-submit");
  setBusy(button, true, "טוען…");
  const result = await getMyChoices(identity.name, identity.id);
  setBusy(button, false);

  if (!result.ok) {
    showFormError($("mine-error"), result.error || "אירעה שגיאה. נסו שוב.");
    return;
  }
  mineIdentity = identity;
  $("mine-form").reset();
  $("mine-form").hidden = true;
  $("mine-results").hidden = false;
  showMyBooks(result.bookIds || []);
}

/** Draws the list of chosen books, each with a "remove" button. */
function showMyBooks(bookIds) {
  const items = bookIds.map(createMineItem);
  $("mine-list").replaceChildren(...items);
  $("mine-empty").hidden = items.length > 0;
}

function createMineItem(bookId) {
  const book = allBooks.find((b) => b.id === Number(bookId));
  const item = document.createElement("li");
  const title = document.createElement("span");
  title.dir = "auto";
  title.textContent = book ? book.title : `ספר שהוסר מהרשימה (מספר ${bookId})`;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-danger btn-small";
  button.textContent = "הסרה";
  button.addEventListener("click", () => handleRemove(bookId, item, button));

  item.append(title, button);
  return item;
}

async function handleRemove(bookId, item, button) {
  if (!mineIdentity) return;
  showFormError($("mine-error"), "");
  setBusy(button, true, "מסיר…");
  const result = await removeChoice(Number(bookId), mineIdentity.name, mineIdentity.id);
  if (!result.ok) {
    setBusy(button, false);
    showFormError($("mine-error"), result.error || "אירעה שגיאה. נסו שוב.");
    return;
  }
  item.remove();
  $("mine-empty").hidden = $("mine-list").children.length > 0;
  refreshCounts();
}

/** Runs every time the pop-up closes: forget the person and empty everything. */
function resetMineDialog() {
  mineIdentity = null;
  $("mine-form").reset();
  for (const field of ["name", "id"]) {
    showFieldError($(`mine-${field}`), $(`mine-${field}-error`), "");
  }
  showFormError($("mine-error"), "");
  $("mine-list").replaceChildren();
  $("mine-form").hidden = false;
  $("mine-results").hidden = true;
}
