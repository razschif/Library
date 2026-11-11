/*
 * script.js - everything the page does: loading the books, filters, sorting,
 * the book cards and the pop-ups.
 *
 * Talking to the server happens ONLY through api.js:
 *   submitChoice, removeChoice, getMyChoices, getBookCounts,
 *   submitReview, getReviews, getSettings, adminGetData, adminSaveSettings,
 *   isDemoMode
 *
 * PRIVACY: names and personal numbers are read from the form, sent to api.js
 * and then cleared. They are never printed to the console, shown on the page
 * or saved in the browser. The one exception: a review is shown with its
 * writer's name and מחזור. Personal numbers are never shown, except to a
 * logged-in admin in the control panel. The admin's details are kept only
 * while the panel is open.
 */

// ---------------------------------------------------------------------------
// Settings and page state
// ---------------------------------------------------------------------------

const BOOKS_FILE = "books.json";
const YEAR_LABELS = { 1: "שנה א'", 2: "שנה ב'", 3: "שנה ג'" };
const MAX_PERSON_ICONS = 5; // how many little person icons to show on a card
const MAX_STARS = 5;

// Compares Hebrew (and English) text the way a Hebrew reader expects.
const hebrewCollator = new Intl.Collator("he", { sensitivity: "base", numeric: true });

let allBooks = [];      // every book from books.json
let bookCounts = {};    // {bookId: how many people chose it}
let currentBook = null; // the book whose "choose" pop-up is open
let bookReviews = {};   // {bookId: [{rating, text, date, name, cohort}], newest first}
let reviewsLoaded = false; // false until the reviews arrive from the server
let reviewBook = null;  // the book whose reviews pop-up is open
let showCovers = false; // admins turn covers on or off in the control panel

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
  setUpReviewDialog();
  setUpAdminDialog();
  refreshSettings(); // runs while the books load; re-draws the cards if needed

  try {
    allBooks = await loadBooks();
  } catch (error) {
    showLoadError();
    return;
  }
  fillSubjectOptions(allBooks);
  renderBooks();
  refreshCounts();
  refreshReviews();
}

/** Downloads books.json and returns the list of books. */
async function loadBooks() {
  const response = await fetch(BOOKS_FILE);
  if (!response.ok) throw new Error("Could not load " + BOOKS_FILE);
  return response.json();
}

/** Downloads the site settings that admins control. */
async function refreshSettings() {
  const result = await getSettings();
  if (result.ok && result.settings) applySettings(result.settings);
}

/** Uses new settings, re-drawing the cards if something visible changed. */
function applySettings(settings) {
  const changed = Boolean(settings.showCovers) !== showCovers;
  showCovers = Boolean(settings.showCovers);
  if (changed && allBooks.length > 0) renderBooks();
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
  fillRating(find(".book-rating"), book.id);
  find(".choose-btn").addEventListener("click", () => openChooseDialog(book));
  find(".reviews-btn").addEventListener("click", () => openReviewDialog(book));
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
  if (!showCovers || !book.cover) return;
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
// Ratings on the cards
// ---------------------------------------------------------------------------

/** Downloads the latest reviews and updates the cards and the open pop-up. */
async function refreshReviews() {
  const result = await getReviews();
  if (!result.ok) return; // reviews are a nice extra; the site works without them
  bookReviews = result.reviews || {};
  reviewsLoaded = true;
  for (const card of document.querySelectorAll(".book-card")) {
    fillRating(card.querySelector(".book-rating"), card.dataset.bookId);
  }
  if (reviewBook) showReviews(reviewBook);
}

/** Returns the average rating with one decimal, e.g. "4.5". */
function averageRating(reviews) {
  const total = reviews.reduce((sum, review) => sum + review.rating, 0);
  return (total / reviews.length).toFixed(1);
}

/** "דירוג אחד" or "3 דירוגים" */
function ratingCountText(count) {
  return count === 1 ? "דירוג אחד" : `${count} דירוגים`;
}

/** Draws filled and empty stars for a rating (rounded to a whole star). */
function createStars(rating) {
  const filledCount = Math.round(rating);
  const stars = document.createElement("span");
  stars.className = "stars";
  stars.setAttribute("role", "img");
  stars.setAttribute("aria-label", `${rating} מתוך ${MAX_STARS} כוכבים`);
  const empty = document.createElement("span");
  empty.className = "stars-empty";
  empty.textContent = "★".repeat(MAX_STARS - filledCount);
  stars.append("★".repeat(filledCount), empty);
  return stars;
}

/** Puts the stars, the average and the number of ratings into an element. */
function fillRatingSummary(element, reviews) {
  element.append(createStars(averageRating(reviews)),
    document.createTextNode(` ${averageRating(reviews)} (${ratingCountText(reviews.length)})`));
}

/** Shows a book's average rating on its card. */
function fillRating(element, bookId) {
  element.replaceChildren();
  if (!reviewsLoaded) return;
  const reviews = bookReviews[bookId] || [];
  if (reviews.length === 0) element.textContent = "עוד לא דורג";
  else fillRatingSummary(element, reviews);
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
  $("choose-cohort").addEventListener("change", () => {
    showFieldError($("choose-cohort"), $("choose-cohort-error"), "");
    showDepartmentField();
  });
  $("choose-department").addEventListener("change", () =>
    showFieldError($("choose-department"), $("choose-department-error"), ""));
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

/** סגל has no מחלקות, so the מחלקה field shows only for the other מחזורים. */
function cohortNeedsDepartment(cohort) {
  return cohort !== "" && cohort !== "סגל";
}

function showDepartmentField() {
  const show = cohortNeedsDepartment($("choose-cohort").value);
  $("choose-department-field").hidden = !show;
  if (!show) {
    $("choose-department").value = "";
    showFieldError($("choose-department"), $("choose-department-error"), "");
  }
}

/** Checks the מחזור and מחלקה fields (only when they are shown). Focuses the first wrong one. */
function validateProfileFields() {
  const cohort = $("choose-cohort");
  const department = $("choose-department");
  const cohortOk = showFieldError(cohort, $("choose-cohort-error"), cohort.value ? "" : "יש לבחור מחזור.");
  const departmentOk = !cohortNeedsDepartment(cohort.value) ||
    showFieldError(department, $("choose-department-error"), department.value ? "" : "יש לבחור מחלקה.");
  if (!cohortOk) cohort.focus();
  else if (!departmentOk) department.focus();
  return cohortOk && departmentOk;
}

async function handleChooseSubmit(event) {
  event.preventDefault();
  showFormError($("choose-error"), "");
  const askingProfile = !$("choose-profile").hidden;
  if (!validateIdentityFields("choose")) return;
  if (askingProfile && !validateProfileFields()) return;

  const button = $("choose-submit");
  setBusy(button, true, "שומר…");
  const result = await submitChoice(
    currentBook.id,
    cleanName($("choose-name").value),
    cleanPersonalId($("choose-id").value),
    askingProfile ? $("choose-cohort").value : "",
    askingProfile ? $("choose-department").value : ""
  );
  setBusy(button, false);

  if (!result.ok && result.needProfile && !askingProfile) {
    // First choice of this person: ask for the מחזור and מחלקה, then they send again.
    $("choose-profile").hidden = false;
    $("choose-cohort").focus();
    return;
  }
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
  for (const field of ["name", "id", "cohort", "department"]) {
    showFieldError($(`choose-${field}`), $(`choose-${field}-error`), "");
  }
  showFormError($("choose-error"), "");
  $("choose-profile").hidden = true;
  $("choose-department-field").hidden = true;
  $("choose-form").hidden = false;
  $("choose-success").hidden = true;
  currentBook = null;
}

// ---------------------------------------------------------------------------
// Pop-up: rating and reviews
// ---------------------------------------------------------------------------

function setUpReviewDialog() {
  const dialog = $("review-dialog");
  setUpCloseButtons(dialog);
  clearErrorWhileTyping("review");
  $("review-form").addEventListener("submit", handleReviewSubmit);
  $("review-form").addEventListener("change", (event) => {
    if (event.target.name === "rating") $("review-rating-error").textContent = "";
    if (event.target.id === "review-cohort") showFieldError(event.target, $("review-cohort-error"), "");
  });
  dialog.addEventListener("close", () => { if (!dialog.open) resetReviewDialog(); });
}

function openReviewDialog(book) {
  resetReviewDialog();
  reviewBook = book;
  $("review-book-title").textContent = book.title;
  showReviews(book);
  $("review-dialog").showModal();
  $("review-heading").focus(); // start at the top, so the reviews are seen first
}

/** Draws the average and the list of reviews of one book. */
function showReviews(book) {
  const reviews = bookReviews[book.id] || [];
  $("review-summary").replaceChildren();
  if (reviews.length > 0) fillRatingSummary($("review-summary"), reviews);
  $("review-list").replaceChildren(...reviews.map(createReviewItem));
  $("review-empty").textContent = reviewsLoaded
    ? "עדיין אין ביקורות על הספר הזה."
    : "הביקורות עדיין לא נטענו.";
  $("review-empty").hidden = reviews.length > 0;
}

function createReviewItem(review) {
  const item = document.createElement("li");
  if (review.name) {
    const author = document.createElement("p");
    author.className = "review-author";
    author.textContent = `${review.name} · ${cohortLabel(review.cohort)}`;
    item.append(author);
  }

  const header = document.createElement("div");
  header.className = "review-header";
  const date = document.createElement("span");
  date.className = "review-date";
  date.textContent = new Date(review.date).toLocaleDateString("he-IL");
  header.append(createStars(review.rating), date);
  item.append(header);

  if (review.text) {
    const text = document.createElement("p");
    text.className = "review-text";
    text.dir = "auto";
    text.textContent = review.text;
    item.append(text);
  }
  return item;
}

/** 'כ"א' -> 'מחזור כ"א', but staff are just "סגל". */
function cohortLabel(cohort) {
  return cohort === "סגל" ? cohort : `מחזור ${cohort}`;
}

async function handleReviewSubmit(event) {
  event.preventDefault();
  showFormError($("review-error"), "");

  const checkedStar = $("review-form").querySelector("input[name=rating]:checked");
  $("review-rating-error").textContent = checkedStar ? "" : "יש לבחור דירוג.";
  const identityOk = validateIdentityFields("review");
  const cohortInput = $("review-cohort");
  const cohortOk = showFieldError(cohortInput, $("review-cohort-error"), cohortInput.value ? "" : "יש לבחור מחזור.");
  if (identityOk && !cohortOk) cohortInput.focus();
  if (!checkedStar || !identityOk || !cohortOk) return;

  const book = reviewBook;
  const button = $("review-submit");
  setBusy(button, true, "שומר…");
  const result = await submitReview(
    book.id,
    cleanName($("review-name").value),
    cleanPersonalId($("review-id").value),
    Number(checkedStar.value),
    $("review-text").value,
    cohortInput.value
  );
  setBusy(button, false);

  // The pop-up may have been closed, or opened on another book, while waiting.
  if (reviewBook === book) {
    if (result.ok) showReviewSaved(result.updated);
    else showFormError($("review-error"), result.error || "אירעה שגיאה. נסו שוב.");
  }
  if (result.ok) refreshReviews();
}

function showReviewSaved(updated) {
  $("review-form").reset(); // forget the name and number right away
  $("review-saved-message").textContent = updated ? "הביקורת שלך עודכנה. תודה!" : "הביקורת נשמרה. תודה!";
  $("review-form").hidden = true;
  $("review-success").hidden = false;
  $("review-success").querySelector("button").focus();
}

/** Runs every time the pop-up closes: back to an empty form. */
function resetReviewDialog() {
  $("review-form").reset();
  for (const field of ["name", "id", "cohort"]) {
    showFieldError($(`review-${field}`), $(`review-${field}-error`), "");
  }
  $("review-rating-error").textContent = "";
  showFormError($("review-error"), "");
  $("review-form").hidden = false;
  $("review-success").hidden = true;
  reviewBook = null;
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

// ---------------------------------------------------------------------------
// Pop-up: admin login and control panel
// ---------------------------------------------------------------------------

// The admin's login details, kept only while the panel is open, so the panel
// can save settings and refresh. Erased when the pop-up closes.
let adminIdentity = null;
let adminChoices = []; // every choice, from the server

function setUpAdminDialog() {
  const dialog = $("admin-dialog");
  setUpCloseButtons(dialog);
  clearErrorWhileTyping("admin");
  $("admin-password").addEventListener("input", () =>
    showFieldError($("admin-password"), $("admin-password-error"), ""));
  $("admin-btn").addEventListener("click", () => {
    resetAdminDialog();
    dialog.showModal();
    $("admin-name").focus();
  });
  $("admin-form").addEventListener("submit", handleAdminLogin);
  $("admin-save-settings").addEventListener("click", handleAdminSaveSettings);
  $("admin-show-covers").addEventListener("change", () => { $("admin-settings-status").textContent = ""; });
  $("admin-refresh").addEventListener("click", handleAdminRefresh);
  $("admin-search").addEventListener("input", renderAdminChoices);
  $("admin-group").addEventListener("change", renderAdminChoices);
  dialog.addEventListener("close", () => { if (!dialog.open) resetAdminDialog(); });
}

async function handleAdminLogin(event) {
  event.preventDefault();
  showFormError($("admin-error"), "");
  const identityOk = validateIdentityFields("admin");
  const passwordInput = $("admin-password");
  const passwordOk = showFieldError(passwordInput, $("admin-password-error"),
    passwordInput.value ? "" : "יש להזין סיסמה.");
  if (identityOk && !passwordOk) passwordInput.focus();
  if (!identityOk || !passwordOk) return;

  const identity = {
    name: cleanName($("admin-name").value),
    id: cleanPersonalId($("admin-id").value),
    password: passwordInput.value,
  };
  const button = $("admin-submit");
  setBusy(button, true, "בודק…");
  const result = await adminGetData(identity.name, identity.id, identity.password);
  setBusy(button, false);

  if (!result.ok) {
    showFormError($("admin-error"), result.error || "אירעה שגיאה. נסו שוב.");
    return;
  }
  adminIdentity = identity;
  $("admin-form").reset();
  $("admin-form").hidden = true;
  $("admin-panel").hidden = false;
  showAdminData(result);
  $("admin-heading").focus();
}

/** Fills the panel with the settings and choices from the server. */
function showAdminData(result) {
  $("admin-show-covers").checked = Boolean(result.settings && result.settings.showCovers);
  adminChoices = result.choices || [];
  renderAdminChoices();
}

async function handleAdminSaveSettings() {
  if (!adminIdentity) return;
  showFormError($("admin-panel-error"), "");
  $("admin-settings-status").textContent = "";
  const button = $("admin-save-settings");
  setBusy(button, true, "שומר…");
  const result = await adminSaveSettings(adminIdentity.name, adminIdentity.id, adminIdentity.password,
    { showCovers: $("admin-show-covers").checked });
  setBusy(button, false);
  if (!result.ok) {
    showFormError($("admin-panel-error"), result.error || "אירעה שגיאה. נסו שוב.");
    return;
  }
  $("admin-show-covers").checked = Boolean(result.settings.showCovers);
  $("admin-settings-status").textContent = "ההגדרות נשמרו ויחולו על כל המשתמשים.";
  applySettings(result.settings); // show the change on this page right away
}

async function handleAdminRefresh() {
  if (!adminIdentity) return;
  showFormError($("admin-panel-error"), "");
  const button = $("admin-refresh");
  setBusy(button, true, "טוען…");
  const result = await adminGetData(adminIdentity.name, adminIdentity.id, adminIdentity.password);
  setBusy(button, false);
  if (!result.ok) {
    showFormError($("admin-panel-error"), result.error || "אירעה שגיאה. נסו שוב.");
    return;
  }
  showAdminData(result);
}

/** The book's current title, or the title saved with the choice if it was removed. */
function adminBookTitle(choice) {
  const book = allBooks.find((b) => b.id === Number(choice.bookId));
  if (book) return book.title;
  return choice.title || `ספר שהוסר מהרשימה (מספר ${choice.bookId})`;
}

/** 'כ"א' + '2' -> 'מחזור כ"א, מחלקה 2'. '' if unknown (choices from before it was asked). */
function profileLabel(choice) {
  if (!choice.cohort) return "";
  const cohort = cohortLabel(choice.cohort);
  return choice.department ? `${cohort}, מחלקה ${choice.department}` : cohort;
}

/** Draws the choices, grouped by person or by book, filtered by the search box. */
function renderAdminChoices() {
  const search = $("admin-search").value.trim().toLowerCase();
  const matches = adminChoices.filter((choice) => !search ||
    [choice.name, choice.personalId, adminBookTitle(choice), profileLabel(choice)].some((text) =>
      String(text).toLowerCase().includes(search)));

  const people = new Set(adminChoices.map((choice) => choice.personalId)).size;
  $("admin-summary").textContent = adminChoices.length === 0 ? "" :
    `סך הכול ${adminChoices.length} בחירות של ${people} אנשים.`;

  const byPerson = $("admin-group").value === "person";
  const groups = new Map();
  for (const choice of matches) {
    const key = byPerson ? choice.personalId : String(choice.bookId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(choice);
  }

  const sections = [...groups.values()].map((choices) => {
    const first = choices[0];
    return {
      title: byPerson ? first.name : adminBookTitle(first),
      subtitle: byPerson
        ? [`מספר אישי ${first.personalId}`, profileLabel(first)].filter(Boolean).join(" · ")
        : "",
      lines: choices.map((choice) => ({
        text: byPerson
          ? adminBookTitle(choice)
          : [`${choice.name} (${choice.personalId})`, profileLabel(choice)].filter(Boolean).join(" · "),
        date: choice.date,
      })),
    };
  });
  // People: by name. Books: most chosen first.
  sections.sort((a, b) => byPerson
    ? hebrewCollator.compare(a.title, b.title)
    : b.lines.length - a.lines.length || hebrewCollator.compare(a.title, b.title));

  $("admin-choices").replaceChildren(...sections.map(createAdminGroup));
  $("admin-empty").textContent = adminChoices.length === 0
    ? "עדיין אין בחירות."
    : "לא נמצאו בחירות שמתאימות לחיפוש.";
  $("admin-empty").hidden = sections.length > 0;
}

function createAdminGroup(section) {
  const group = document.createElement("section");
  group.className = "admin-group";

  const heading = document.createElement("h4");
  heading.dir = "auto";
  heading.textContent = section.title;
  const count = document.createElement("span");
  count.className = "admin-count";
  count.textContent = section.lines.length === 1 ? "בחירה אחת" : `${section.lines.length} בחירות`;
  heading.append(" ", count);
  group.append(heading);

  if (section.subtitle) {
    const subtitle = document.createElement("p");
    subtitle.className = "admin-subtitle";
    subtitle.textContent = section.subtitle;
    group.append(subtitle);
  }

  const list = document.createElement("ul");
  for (const line of section.lines) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.dir = "auto";
    text.textContent = line.text;
    const date = document.createElement("span");
    date.className = "review-date";
    const parsed = new Date(line.date);
    date.textContent = isNaN(parsed) ? "" : parsed.toLocaleDateString("he-IL");
    item.append(text, date);
    list.append(item);
  }
  group.append(list);
  return group;
}

/** Runs every time the pop-up closes: forget the admin and empty everything. */
function resetAdminDialog() {
  adminIdentity = null;
  adminChoices = [];
  $("admin-form").reset();
  for (const field of ["name", "id", "password"]) {
    showFieldError($(`admin-${field}`), $(`admin-${field}-error`), "");
  }
  showFormError($("admin-error"), "");
  showFormError($("admin-panel-error"), "");
  $("admin-settings-status").textContent = "";
  $("admin-search").value = "";
  $("admin-choices").replaceChildren();
  $("admin-summary").textContent = "";
  $("admin-empty").hidden = true;
  $("admin-form").hidden = false;
  $("admin-panel").hidden = true;
}
