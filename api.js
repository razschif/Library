/*
 * api.js - ALL communication with the server lives in this file.
 *
 * The rest of the site only calls these functions:
 *   submitChoice(bookId, name, id)  -> add a book to a person's choices
 *   removeChoice(bookId, name, id)  -> remove a book from a person's choices
 *   getMyChoices(name, id)          -> the book ids a person chose
 *   getBookCounts()                 -> {bookId: number of people}, no personal details
 *   submitReview(bookId, name, id, rating, text, cohort) -> save (or replace) a person's review
 *   getReviews()                    -> {bookId: [{rating, text, date, name, cohort}]}, no personal numbers
 *   isDemoMode()                    -> true if no server is connected yet
 *
 * Every function returns a Promise of an object:
 *   {ok: true, ...}  or  {ok: false, error: "Hebrew message to show"}
 *
 * To switch to a different backend later, change only this file and keep
 * the same function names and the same kind of answers.
 *
 * PRIVACY: names and personal numbers are only sent to the server.
 * This file never logs them, never shows them and never saves them in the browser.
 * The one public exception: a review is published with its writer's name and
 * מחזור. Personal numbers are never published.
 */

// Paste the Google Apps Script web app URL here (it ends with /exec).
// While it is empty, the site runs in DEMO MODE: choices are kept only in
// this browser tab's memory and disappear when the page reloads.
const API_URL = "https://script.google.com/macros/s/AKfycbyq46E3OfzIs8_MMKIadRmfA7kREEBaENMg3egSdkLfMyCxht2M_xYUXnN8DYGM9ohHZQ/exec";

const NETWORK_ERROR = "לא ניתן להתחבר לשרת. בדקו את החיבור לאינטרנט ונסו שוב.";

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

function isDemoMode() {
  return API_URL === "";
}

function submitChoice(bookId, name, id) {
  if (isDemoMode()) return demoServer.add(bookId, name, id);
  return postToServer({ action: "add", bookId, name, id });
}

function removeChoice(bookId, name, id) {
  if (isDemoMode()) return demoServer.remove(bookId, name, id);
  return postToServer({ action: "remove", bookId, name, id });
}

function getMyChoices(name, id) {
  if (isDemoMode()) return demoServer.mine(name, id);
  return postToServer({ action: "mine", name, id });
}

function getBookCounts() {
  if (isDemoMode()) return demoServer.counts();
  return getFromServer("counts");
}

function submitReview(bookId, name, id, rating, text, cohort) {
  if (isDemoMode()) return demoServer.review(bookId, name, id, rating, text, cohort);
  return postToServer({ action: "review", bookId, name, id, rating, text, cohort });
}

function getReviews() {
  if (isDemoMode()) return demoServer.reviews();
  return getFromServer("reviews");
}

// ---------------------------------------------------------------------------
// Talking to Google Apps Script
// ---------------------------------------------------------------------------

/** Asks the server for public information (never personal details). */
async function getFromServer(action) {
  try {
    const response = await fetch(`${API_URL}?action=${action}`);
    return await response.json();
  } catch (error) {
    return { ok: false, error: NETWORK_ERROR };
  }
}

/*
 * Sends data to the server with POST.
 * We send it as "text/plain" on purpose: Apps Script can't answer the extra
 * "may I send JSON?" check (CORS preflight) that browsers do for "application/json".
 */
async function postToServer(data) {
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(data),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, error: NETWORK_ERROR };
  }
}

// ---------------------------------------------------------------------------
// Demo server (used only while API_URL is empty)
// It follows the same rules as apps-script/Code.gs, so you can try the site
// before the real server exists. Everything is lost when the page reloads.
// ---------------------------------------------------------------------------

const demoServer = (() => {
  const people = new Map(); // personal id -> {name, bookIds: Set}
  const reviewers = new Map(); // personal id -> {name, byBook: Map(bookId -> review)}

  // Wait a little, like a real network request would.
  const answer = (result) => new Promise((resolve) => setTimeout(() => resolve(result), 300));
  const cleanName = (name) => String(name).replace(/\s+/g, " ").trim();

  function checkPerson(name, id) {
    const person = people.get(id) || reviewers.get(id);
    if (person && person.name !== cleanName(name)) {
      return "השם לא תואם לשם שנרשם עם המספר האישי הזה. יש להקליד את השם בדיוק כמו בפעם הראשונה.";
    }
    return "";
  }

  return {
    add(bookId, name, id) {
      const error = checkPerson(name, id);
      if (error) return answer({ ok: false, error });
      const person = people.get(id) || { name: cleanName(name), bookIds: new Set() };
      if (person.bookIds.has(bookId)) {
        return answer({ ok: false, error: 'כבר בחרת בספר הזה. הוא מופיע ב"הבחירות שלי".' });
      }
      person.bookIds.add(bookId);
      people.set(id, person);
      return answer({ ok: true });
    },
    remove(bookId, name, id) {
      const error = checkPerson(name, id);
      if (error) return answer({ ok: false, error });
      const person = people.get(id);
      if (!person || !person.bookIds.delete(bookId)) {
        return answer({ ok: false, error: "הספר הזה לא נמצא בבחירות שלך." });
      }
      if (person.bookIds.size === 0) people.delete(id);
      return answer({ ok: true });
    },
    mine(name, id) {
      const error = checkPerson(name, id);
      if (error) return answer({ ok: false, error });
      const person = people.get(id);
      return answer({ ok: true, bookIds: person ? [...person.bookIds] : [] });
    },
    counts() {
      const counts = {};
      for (const person of people.values()) {
        for (const bookId of person.bookIds) counts[bookId] = (counts[bookId] || 0) + 1;
      }
      return answer({ ok: true, counts });
    },
    review(bookId, name, id, rating, text, cohort) {
      const error = checkPerson(name, id);
      if (error) return answer({ ok: false, error });
      if (![1, 2, 3, 4, 5].includes(rating)) {
        return answer({ ok: false, error: "יש לבחור דירוג של 1 עד 5 כוכבים." });
      }
      if (!['כ', 'כ"א', 'כ"ב', 'סגל'].includes(cohort)) {
        return answer({ ok: false, error: "יש לבחור מחזור." });
      }
      const reviewer = reviewers.get(id) || { name: cleanName(name), byBook: new Map() };
      const updated = reviewer.byBook.has(bookId);
      reviewer.byBook.set(bookId, {
        rating, text: text.trim(), date: new Date().toISOString(), name: reviewer.name, cohort,
      });
      reviewers.set(id, reviewer);
      return answer({ ok: true, updated });
    },
    reviews() {
      const all = [];
      for (const reviewer of reviewers.values()) {
        for (const [bookId, review] of reviewer.byBook) all.push({ bookId, review });
      }
      all.sort((a, b) => (a.review.date < b.review.date ? 1 : -1));
      const reviews = {};
      for (const { bookId, review } of all) (reviews[bookId] = reviews[bookId] || []).push(review);
      return answer({ ok: true, reviews });
    },
  };
})();
