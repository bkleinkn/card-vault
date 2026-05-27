// Card Vault — main client script.
// Phase 1 ships with a mocked identify response so the camera/UX loop
// can be proven on a real phone before any Cloud Function or OpenAI cost.
// Phase 2 swaps `mockIdentify` for a fetch to the deployed identifyCard function.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  updateDoc,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js";
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";

// --- Firebase config -------------------------------------------------------
// Filled in when the Firebase project is provisioned (see CLAUDE.md Phase 2).
const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};

const FIREBASE_READY = !firebaseConfig.apiKey.startsWith("REPLACE_");

let auth, db, storage, functions, currentUser;

if (FIREBASE_READY) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
  functions = getFunctions(app, "us-central1");

  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    document.getElementById("user-chip").textContent = user ? "Signed in" : "";
    if (location.hash === "#/collection") renderCollection();
  });

  signInAnonymously(auth).catch((err) => {
    console.error("Anonymous sign-in failed", err);
    document.getElementById("user-chip").textContent = "Offline";
  });
} else {
  document.getElementById("user-chip").textContent = "Demo mode";
}

// --- State -----------------------------------------------------------------
const state = {
  frontFile: null,
  backFile: null,
  lastIdentified: null, // { identified, valueEstimate }
  notes: "",
  editingResult: false,
};

// Detail-view state holds the loaded card so editing/cancel can re-render
// without re-fetching.
const detailState = {
  cardId: null,
  card: null,
  editing: false,
};

// --- Routing ---------------------------------------------------------------
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => {
    v.hidden = v.dataset.view !== name;
  });
  document.querySelectorAll(".navlink").forEach((a) => {
    a.classList.toggle("active", a.dataset.nav === name);
  });
}

function route() {
  const hash = location.hash || "#/scan";
  if (hash.startsWith("#/scan")) {
    showView("scan");
  } else if (hash.startsWith("#/collection")) {
    showView("collection");
    renderCollection();
  } else if (hash.startsWith("#/detail/")) {
    const id = hash.split("/")[2];
    showView("detail");
    renderDetail(id);
  } else if (hash.startsWith("#/result")) {
    showView("result");
  } else if (hash.startsWith("#/about")) {
    showView("about");
  } else {
    showView("scan");
  }
}
window.addEventListener("hashchange", route);

// --- Scan view -------------------------------------------------------------
const previewsEl = document.getElementById("scan-previews");
const identifyBtn = document.getElementById("identify-btn");
const scanStatus = document.getElementById("scan-status");
const resultNotesEl = document.getElementById("result-notes");

document.getElementById("capture-front").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  state.frontFile = f;
  renderPreviews();
});

document.getElementById("capture-back").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  state.backFile = f;
  renderPreviews();
});

function renderPreviews() {
  previewsEl.innerHTML = "";
  if (state.frontFile) {
    const img = document.createElement("img");
    img.alt = "Front";
    img.src = URL.createObjectURL(state.frontFile);
    previewsEl.appendChild(img);
  }
  if (state.backFile) {
    const img = document.createElement("img");
    img.alt = "Back";
    img.src = URL.createObjectURL(state.backFile);
    previewsEl.appendChild(img);
  }
  identifyBtn.disabled = !state.frontFile;
}

identifyBtn.addEventListener("click", async () => {
  if (!state.frontFile) return;
  identifyBtn.disabled = true;
  scanStatus.textContent = "Looking at your card...";
  try {
    const result = await identifyCard(state.frontFile, state.backFile);
    state.lastIdentified = result;
    state.editingResult = false;
    renderResult(result);
    scanStatus.textContent = "";
    location.hash = "#/result";
  } catch (err) {
    console.error(err);
    scanStatus.textContent = "Sorry, couldn't read this one. Try a clearer photo in better light.";
  } finally {
    identifyBtn.disabled = false;
  }
});

// Bind result-view notes textarea so user input mirrors into state.
resultNotesEl.addEventListener("input", (e) => {
  state.notes = e.target.value;
});

// --- Identify --------------------------------------------------------------
// Real path: shrink images client-side, call the identifyCard Cloud Function.
// Demo fallback: mock response when Firebase isn't configured yet.

async function identifyCard(frontFile, backFile) {
  if (!FIREBASE_READY || !currentUser) {
    return mockIdentify();
  }
  const frontImageBase64 = await fileToShrunkBase64(frontFile);
  const backImageBase64 = backFile ? await fileToShrunkBase64(backFile) : null;
  const callable = httpsCallable(functions, "identifyCard");
  const res = await callable({ frontImageBase64, backImageBase64 });
  return res.data;
}

async function mockIdentify() {
  await new Promise((r) => setTimeout(r, 800));
  return {
    identified: {
      sport: "baseball",
      year: 1956,
      set: "Topps",
      player: "Mickey Mantle",
      cardNumber: "135",
      isRookie: false,
      isHOF: true,
      confidence: 0.82,
    },
    valueEstimate: {
      low: 600,
      high: 2500,
      note: "Rough estimate. Verify with recent eBay sold listings before buying or selling.",
      estimatedAt: new Date().toISOString(),
    },
  };
}

// Resize to 1280px on the longest side + JPEG @ 0.85 before base64 encoding.
// Keeps OpenAI Vision payloads small without hurting card OCR quality.
async function fileToShrunkBase64(file, maxDim = 1280) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
}

// --- Result view -----------------------------------------------------------
function renderResult(data) {
  if (state.editingResult) {
    renderResultEditForm();
    return;
  }
  const { identified, valueEstimate } = data;
  const el = document.getElementById("result-card");
  const highValue = (valueEstimate?.high || 0) >= 250;
  const uncertain = (identified.confidence || 0) < 0.5;

  el.innerHTML = `
    ${highValue ? `<div class="high-value-banner">This may be a valuable card. Get a professional appraisal before selling.</div>` : ""}
    ${uncertain ? `<div class="uncertain-banner">I'm not very sure about this one. Does it look right? Tap <strong>Edit details</strong> below to fix anything.</div>` : ""}
    <p class="player">${esc(identified.player)}</p>
    <p class="meta">${identified.year ?? ""} ${esc(identified.set || "")} ${identified.cardNumber ? `#${esc(identified.cardNumber)}` : ""} &mdash; ${esc(identified.sport || "")}</p>
    <div class="badges">
      ${identified.isRookie ? `<span class="badge rookie">Rookie</span>` : ""}
      ${identified.isHOF ? `<span class="badge hof">Hall of Fame</span>` : ""}
      <span class="badge">Confidence ${Math.round((identified.confidence || 0) * 100)}%</span>
    </div>
    <div class="value-block">
      <div class="label muted">Rough value</div>
      <div class="range">$${fmt(valueEstimate?.low || 0)} &ndash; $${fmt(valueEstimate?.high || 0)}</div>
      <div class="note">${esc(valueEstimate?.note || "")}</div>
    </div>
    <button id="edit-details-btn" class="link-button" style="margin-top: 10px;">Edit details</button>
  `;

  document.getElementById("edit-details-btn").addEventListener("click", () => {
    state.editingResult = true;
    renderResult(state.lastIdentified);
  });
}

function renderResultEditForm() {
  const id = state.lastIdentified.identified || {};
  const el = document.getElementById("result-card");
  el.innerHTML =
    renderEditFormHTML(id) +
    `<div class="row">
       <button id="apply-edits-btn" class="big-button primary">Save changes</button>
       <button id="cancel-edits-btn" class="big-button">Cancel</button>
     </div>`;

  document.getElementById("apply-edits-btn").addEventListener("click", () => {
    state.lastIdentified.identified = {
      ...state.lastIdentified.identified,
      ...readEditFormValues(),
      userEdited: true,
    };
    state.editingResult = false;
    renderResult(state.lastIdentified);
  });
  document.getElementById("cancel-edits-btn").addEventListener("click", () => {
    state.editingResult = false;
    renderResult(state.lastIdentified);
  });
}

// Shared form markup — caller is responsible for the apply/cancel buttons.
function renderEditFormHTML(identified) {
  const sports = ["baseball", "football", "basketball", "hockey", "other"];
  return `
    <p class="edit-title">Edit card details</p>
    <div class="edit-form">
      <label>Player name
        <input id="ed-player" type="text" value="${esc(identified.player || "")}" autocomplete="off" />
      </label>
      <label>Year
        <input id="ed-year" type="number" value="${identified.year || ""}" min="1880" max="2030" inputmode="numeric" />
      </label>
      <label>Set / Manufacturer
        <input id="ed-set" type="text" value="${esc(identified.set || "")}" placeholder="e.g. Topps, Bowman, Goudey" autocomplete="off" />
      </label>
      <label>Card number
        <input id="ed-cardNumber" type="text" value="${esc(identified.cardNumber || "")}" autocomplete="off" />
      </label>
      <label>Sport
        <select id="ed-sport">
          ${sports
            .map(
              (s) =>
                `<option value="${s}" ${identified.sport === s ? "selected" : ""}>${s[0].toUpperCase()}${s.slice(1)}</option>`,
            )
            .join("")}
        </select>
      </label>
      <label class="checkbox">
        <input id="ed-isRookie" type="checkbox" ${identified.isRookie ? "checked" : ""} />
        <span>Rookie card</span>
      </label>
      <label class="checkbox">
        <input id="ed-isHOF" type="checkbox" ${identified.isHOF ? "checked" : ""} />
        <span>Hall of Famer</span>
      </label>
    </div>
  `;
}

function readEditFormValues() {
  const yearRaw = parseInt(document.getElementById("ed-year").value, 10);
  return {
    player: document.getElementById("ed-player").value.trim(),
    year: Number.isFinite(yearRaw) ? yearRaw : null,
    set: document.getElementById("ed-set").value.trim(),
    cardNumber: document.getElementById("ed-cardNumber").value.trim(),
    sport: document.getElementById("ed-sport").value,
    isRookie: document.getElementById("ed-isRookie").checked,
    isHOF: document.getElementById("ed-isHOF").checked,
  };
}

document.getElementById("rescan-btn").addEventListener("click", () => {
  state.frontFile = null;
  state.backFile = null;
  state.lastIdentified = null;
  state.notes = "";
  state.editingResult = false;
  resultNotesEl.value = "";
  renderPreviews();
  document.getElementById("capture-front").value = "";
  document.getElementById("capture-back").value = "";
  scanStatus.textContent = "";
  location.hash = "#/scan";
});

document.getElementById("save-btn").addEventListener("click", async () => {
  if (!state.lastIdentified) return;
  if (!FIREBASE_READY || !currentUser) {
    alert("Firebase isn't connected yet. Card not saved (demo mode).");
    return;
  }
  const saveBtn = document.getElementById("save-btn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";
  try {
    const cardId = crypto.randomUUID();
    const frontUrl = await uploadImage(state.frontFile, cardId, "front");
    const backUrl = state.backFile ? await uploadImage(state.backFile, cardId, "back") : null;
    await setDoc(doc(db, "users", currentUser.uid, "cards", cardId), {
      createdAt: serverTimestamp(),
      imageFrontUrl: frontUrl,
      imageBackUrl: backUrl,
      identified: state.lastIdentified.identified,
      valueEstimate: state.lastIdentified.valueEstimate,
      userNotes: state.notes || null,
    });
    state.frontFile = null;
    state.backFile = null;
    state.lastIdentified = null;
    state.notes = "";
    state.editingResult = false;
    resultNotesEl.value = "";
    location.hash = "#/collection";
  } catch (err) {
    console.error(err);
    alert("Save failed. Try again.");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save to collection";
  }
});

async function uploadImage(file, cardId, side) {
  const path = `scans/${currentUser.uid}/${cardId}/${side}.jpg`;
  const r = storageRef(storage, path);
  await uploadBytes(r, file, { contentType: file.type || "image/jpeg" });
  return getDownloadURL(r);
}

// --- Collection view -------------------------------------------------------
const collectionListEl = document.getElementById("collection-list");
const collectionEmptyEl = document.getElementById("collection-empty");
const collectionTotalEl = document.getElementById("collection-total");
const collectionSearchEl = document.getElementById("collection-search");

let cardsCache = [];

async function renderCollection() {
  if (!FIREBASE_READY || !currentUser) {
    collectionListEl.innerHTML = "";
    collectionEmptyEl.innerHTML = `<p>Firebase not connected yet (demo mode).</p>`;
    collectionEmptyEl.hidden = false;
    collectionTotalEl.textContent = "";
    return;
  }
  const snap = await getDocs(
    query(collection(db, "users", currentUser.uid, "cards"), orderBy("createdAt", "desc")),
  );
  cardsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  drawCollection();
}

function drawCollection() {
  const term = (collectionSearchEl.value || "").trim().toLowerCase();
  const filtered = term
    ? cardsCache.filter((c) => {
        const haystack = `${c.identified?.player || ""} ${c.identified?.year || ""} ${c.identified?.set || ""}`.toLowerCase();
        return haystack.includes(term);
      })
    : cardsCache;

  if (cardsCache.length === 0) {
    collectionEmptyEl.innerHTML = `
      <p>No cards yet. Scan one to get started.</p>
      <a href="#/scan" class="big-button primary cta">Scan your first card</a>
    `;
    collectionEmptyEl.hidden = false;
  } else if (filtered.length === 0) {
    collectionEmptyEl.innerHTML = `<p>No cards match &ldquo;${esc(term)}&rdquo;.</p>`;
    collectionEmptyEl.hidden = false;
  } else {
    collectionEmptyEl.hidden = true;
  }

  const totalLow = cardsCache.reduce((s, c) => s + (c.valueEstimate?.low || 0), 0);
  const totalHigh = cardsCache.reduce((s, c) => s + (c.valueEstimate?.high || 0), 0);
  collectionTotalEl.textContent = cardsCache.length
    ? `${cardsCache.length} cards • $${fmt(totalLow)}–$${fmt(totalHigh)} est.`
    : "";

  collectionListEl.innerHTML = filtered
    .map(
      (c) => `
      <a class="collection-card" href="#/detail/${c.id}">
        <img src="${esc(c.imageFrontUrl || "")}" alt="${esc(c.identified?.player || "Card")}" />
        <div class="info">
          <div class="name">${esc(c.identified?.player || "Unknown")}</div>
          <div class="sub">${esc(c.identified?.year || "")} ${esc(c.identified?.set || "")}</div>
          <div class="price">$${fmt(c.valueEstimate?.low || 0)}–$${fmt(c.valueEstimate?.high || 0)}</div>
        </div>
      </a>`,
    )
    .join("");
}

collectionSearchEl.addEventListener("input", drawCollection);

// --- Detail view -----------------------------------------------------------
async function renderDetail(cardId) {
  const el = document.getElementById("detail-content");
  if (!FIREBASE_READY || !currentUser) {
    el.innerHTML = `<p class="muted">Firebase not connected yet (demo mode).</p>`;
    return;
  }

  // Cache the loaded card so editing flow can re-render without re-fetching.
  if (detailState.cardId !== cardId || !detailState.card) {
    el.innerHTML = `<p class="muted">Loading...</p>`;
    const snap = await getDoc(doc(db, "users", currentUser.uid, "cards", cardId));
    if (!snap.exists()) {
      el.innerHTML = `<p class="muted">Card not found.</p>`;
      return;
    }
    detailState.cardId = cardId;
    detailState.card = snap.data();
    detailState.editing = false;
  }

  if (detailState.editing) {
    renderDetailEditing(el);
  } else {
    renderDetailDisplay(el);
  }
}

function renderDetailDisplay(el) {
  const c = detailState.card;
  const highValue = (c.valueEstimate?.high || 0) >= 250;
  const uncertain = (c.identified?.confidence || 0) < 0.5 && !c.identified?.userEdited;

  el.innerHTML = `
    ${highValue ? `<div class="high-value-banner">This may be a valuable card. Get a professional appraisal before selling.</div>` : ""}
    ${uncertain ? `<div class="uncertain-banner">The AI wasn't very sure about this one. Tap <strong>Edit details</strong> to correct anything.</div>` : ""}
    <div class="result-card">
      <p class="player">${esc(c.identified?.player || "Unknown")}</p>
      <p class="meta">${c.identified?.year || ""} ${esc(c.identified?.set || "")} ${c.identified?.cardNumber ? `#${esc(c.identified.cardNumber)}` : ""} &mdash; ${esc(c.identified?.sport || "")}</p>
      <div class="badges">
        ${c.identified?.isRookie ? `<span class="badge rookie">Rookie</span>` : ""}
        ${c.identified?.isHOF ? `<span class="badge hof">Hall of Fame</span>` : ""}
        ${typeof c.identified?.confidence === "number" ? `<span class="badge">Confidence ${Math.round(c.identified.confidence * 100)}%</span>` : ""}
      </div>
      <div class="value-block">
        <div class="label muted">Rough value</div>
        <div class="range">$${fmt(c.valueEstimate?.low || 0)} &ndash; $${fmt(c.valueEstimate?.high || 0)}</div>
        <div class="note">${esc(c.valueEstimate?.note || "")}</div>
      </div>
    </div>
    ${c.userNotes ? `<div class="notes-display">${esc(c.userNotes)}</div>` : ""}
    <div class="row">
      <button id="detail-edit-btn" class="big-button">Edit details &amp; notes</button>
    </div>
    ${c.imageFrontUrl ? `<img src="${esc(c.imageFrontUrl)}" alt="Front" />` : ""}
    ${c.imageBackUrl ? `<img src="${esc(c.imageBackUrl)}" alt="Back" />` : ""}
    <button id="delete-btn" class="big-button" style="color:var(--danger);">Remove from collection</button>
  `;

  document.getElementById("detail-edit-btn").addEventListener("click", () => {
    detailState.editing = true;
    renderDetail(detailState.cardId);
  });
  document.getElementById("delete-btn").addEventListener("click", async () => {
    if (!confirm("Remove this card from your collection?")) return;
    try {
      await deleteDoc(doc(db, "users", currentUser.uid, "cards", detailState.cardId));
      detailState.cardId = null;
      detailState.card = null;
      detailState.editing = false;
      location.hash = "#/collection";
    } catch (err) {
      console.error(err);
      alert("Couldn't remove. Try again.");
    }
  });
}

function renderDetailEditing(el) {
  const c = detailState.card;
  el.innerHTML =
    renderEditFormHTML(c.identified || {}) +
    `<div class="notes-section">
       <label for="detail-notes">Your notes</label>
       <textarea id="detail-notes" placeholder="e.g. From Grandpa's collection">${esc(c.userNotes || "")}</textarea>
     </div>
     <div class="row">
       <button id="detail-apply-btn" class="big-button primary">Save changes</button>
       <button id="detail-cancel-btn" class="big-button">Cancel</button>
     </div>`;

  document.getElementById("detail-apply-btn").addEventListener("click", async () => {
    const applyBtn = document.getElementById("detail-apply-btn");
    applyBtn.disabled = true;
    applyBtn.textContent = "Saving...";
    const updatedIdentified = { ...c.identified, ...readEditFormValues(), userEdited: true };
    const updatedNotes = document.getElementById("detail-notes").value;
    try {
      await updateDoc(doc(db, "users", currentUser.uid, "cards", detailState.cardId), {
        identified: updatedIdentified,
        userNotes: updatedNotes || null,
      });
      detailState.card = { ...c, identified: updatedIdentified, userNotes: updatedNotes || null };
      detailState.editing = false;
      renderDetail(detailState.cardId);
    } catch (err) {
      console.error(err);
      alert("Couldn't save changes. Try again.");
      applyBtn.disabled = false;
      applyBtn.textContent = "Save changes";
    }
  });
  document.getElementById("detail-cancel-btn").addEventListener("click", () => {
    detailState.editing = false;
    renderDetail(detailState.cardId);
  });
}

document.getElementById("back-btn").addEventListener("click", () => {
  history.back();
});

// --- Helpers ---------------------------------------------------------------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function fmt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

// --- Boot ------------------------------------------------------------------
route();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
