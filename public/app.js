// Card Vault — main client script.
// Identify runs through the deployed `identifyCard` Cloud Function, which calls
// Claude (Anthropic) and returns structured JSON. A local `mockIdentify`
// response is retained behind the USE_MOCK_AI flag for cost-free UX iteration
// and as a fallback before sign-in / when Firebase isn't wired.

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
  where,
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
  apiKey: "AIzaSyAogtHc_TIr9Emsv-nRdxeT8KFKYWnwuUc",
  authDomain: "card-vault-d8fa4.firebaseapp.com",
  projectId: "card-vault-d8fa4",
  storageBucket: "card-vault-d8fa4.firebasestorage.app",
  messagingSenderId: "1007054529380",
  appId: "1:1007054529380:web:389084401e080bf39ad071",
};

const FIREBASE_READY = !firebaseConfig.apiKey.startsWith("REPLACE_");

// Keep the mock identify response active even after Firebase is wired.
// Useful when deploying without an Anthropic API key. Flip to false once you've
// set the ANTHROPIC_API_KEY secret and deployed the identifyCard Cloud Function.
const USE_MOCK_AI = false;

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
    // Re-render whatever view is active (detail, locations, collection) now that
    // currentUser is known — fixes the detail view dead-ending on "Signing in…".
    route();
    // Populate the review-pool count / badges / banners now that we can query.
    refreshPendingCount();
  });

  signInAnonymously(auth).catch((err) => {
    console.error("Anonymous sign-in failed", err);
    document.getElementById("user-chip").textContent = "Offline";
  });
} else {
  document.getElementById("user-chip").textContent = "Demo mode";
}

// IS_DEMO is true only when Firebase isn't configured. In production
// (FIREBASE_READY === true) it is always false, so the demo subsystem below
// (SAMPLE_CARDS, demo banners) is effectively dead code on the live site — kept
// for local/offline development. Left in place deliberately; do not rely on it
// in production.
const IS_DEMO = !FIREBASE_READY;

// Value at/above which we surface the "worth a closer look" banner. Kept in one
// place so the result and detail views can't drift apart.
const HIGH_VALUE_THRESHOLD = 250;

// Object URLs created for the scan-view previews. Tracked module-wide so each
// render (and a reset) can revoke the previous ones instead of leaking blobs.
let previewUrls = [];

// --- State -----------------------------------------------------------------
const state = {
  frontFile: null,
  backFile: null,
  lastIdentified: null, // { identified, valueEstimate, itemType }
  notes: "",
  editingResult: false,
  reviewJobId: null,    // when set, the result view is reviewing a queued scan
  itemType: "card",     // what the scanner is currently set to: card | pack | box
  bulkLocationId: null, // bulk mode: location auto-applied to every pending card
};

// Review-screen state: which pending card is being reviewed, its loaded data,
// and whether the inline edit form is open. Mirrors detailState.
const reviewState = {
  cardId: null,
  card: null,
  editing: false,
};

const detailState = {
  cardId: null,
  card: null,
  editing: false,
};

const collectionFilters = {
  sort: "newest",
  sport: "all",
  itemType: "all",
  location: "all",
  rookieOnly: false,
  hofOnly: false,
  yearFrom: null,
  yearTo: null,
};

// User-defined storage locations (binder, box, shelf…). Loaded from Firestore
// at users/{uid}/locations. Cards reference one by `locationId`; the name is
// resolved from this cache so a rename propagates everywhere automatically.
let locationsCache = [];

// --- Sample cards (demo mode only) -----------------------------------------
// Auto-loaded into the collection when Firebase isn't wired so users can
// actually exercise search/sort/filter before Phase 2 deploys.
function makeSampleImg(label) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 140'>
    <defs>
      <linearGradient id='g' x1='0' y1='0' x2='1' y2='0'>
        <stop offset='0' stop-color='#f59e0b'/>
        <stop offset='0.5' stop-color='#f43f5e'/>
        <stop offset='1' stop-color='#6366f1'/>
      </linearGradient>
    </defs>
    <rect width='100' height='140' fill='#0f172a'/>
    <rect x='5' y='5' width='90' height='130' fill='#020617' stroke='#6366f1' stroke-width='1.5' rx='4'/>
    <rect x='10' y='10' width='80' height='3' rx='1.5' fill='url(#g)'/>
    <text x='50' y='75' text-anchor='middle' font-family='Inter, sans-serif' font-size='11' font-weight='800' fill='#e0e7ff'>${label}</text>
    <text x='50' y='92' text-anchor='middle' font-family='ui-monospace, monospace' font-size='6' fill='#64748b' letter-spacing='1'>SAMPLE</text>
  </svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

// Strip "Jr." / "Sr." / "II" / "III" so the placeholder image label uses the surname.
function imgLabel(player) {
  const parts = String(player || "").split(" ");
  const last = parts[parts.length - 1];
  if (["Jr.", "Sr.", "II", "III"].includes(last)) return parts[parts.length - 2] || player;
  return last;
}

// 50 sample cards across 10 manufacturers and 4 sports, 1933–1990. Tuned so the
// Manufacturer → Year → Team hierarchy actually shows depth (Topps 1956 alone
// has cards across 4 teams; Bowman, Goudey, Play Ball, Donruss, Score, Pro Set,
// Fleer, Upper Deck, and O-Pee-Chee round out the manufacturer dimension).
// Format: [daysAgo, sport, year, set, player, cardNumber, team, isRookie, isHOF, valueLow, valueHigh, notes?]
const SAMPLE_RAW = [
  [1,  "baseball",   1952, "Topps",      "Mickey Mantle",    "311", "Yankees",   false, true,  50000, 150000],
  [2,  "baseball",   1952, "Topps",      "Willie Mays",      "261", "Giants",    false, true,  3000,  10000],
  [3,  "baseball",   1952, "Topps",      "Eddie Mathews",    "407", "Braves",    true,  true,  5000,  15000],
  [4,  "baseball",   1956, "Topps",      "Mickey Mantle",    "135", "Yankees",   false, true,  600,   2500, "From Grandpa's collection"],
  [5,  "baseball",   1956, "Topps",      "Yogi Berra",       "110", "Yankees",   false, true,  300,   1200],
  [6,  "baseball",   1956, "Topps",      "Don Larsen",       "410", "Yankees",   false, false, 50,    200],
  [7,  "baseball",   1956, "Topps",      "Ted Williams",     "5",   "Red Sox",   false, true,  400,   1800],
  [8,  "baseball",   1956, "Topps",      "Hank Aaron",       "31",  "Braves",    false, true,  300,   1200],
  [9,  "baseball",   1956, "Topps",      "Willie Mays",      "130", "Giants",    false, true,  400,   1500],
  [10, "baseball",   1956, "Topps",      "Sandy Koufax",     "79",  "Dodgers",   false, true,  300,   1000],
  [11, "baseball",   1957, "Topps",      "Mickey Mantle",    "95",  "Yankees",   false, true,  300,   1200],
  [12, "baseball",   1957, "Topps",      "Brooks Robinson",  "328", "Orioles",   true,  true,  400,   1500],
  [13, "baseball",   1957, "Topps",      "Don Drysdale",     "18",  "Dodgers",   true,  true,  200,   800],
  [14, "baseball",   1962, "Topps",      "Roger Maris",      "1",   "Yankees",   false, false, 250,   800],
  [15, "baseball",   1962, "Topps",      "Mickey Mantle",    "200", "Yankees",   false, true,  200,   700],
  [16, "baseball",   1962, "Topps",      "Bob Gibson",       "530", "Cardinals", false, true,  150,   500],
  [17, "baseball",   1968, "Topps",      "Nolan Ryan",       "177", "Mets",      true,  true,  1500,  5000],
  [18, "baseball",   1968, "Topps",      "Johnny Bench",     "247", "Reds",      true,  true,  500,   2000],
  [19, "baseball",   1968, "Topps",      "Tom Seaver",       "45",  "Mets",      false, true,  200,   700],
  [20, "baseball",   1969, "Topps",      "Reggie Jackson",   "260", "A's",       true,  true,  800,   3000],
  [21, "baseball",   1972, "Topps",      "Carlton Fisk",     "79",  "Red Sox",   true,  true,  100,   400],
  [22, "baseball",   1973, "Topps",      "Mike Schmidt",     "615", "Phillies",  true,  true,  200,   800],
  [23, "baseball",   1975, "Topps",      "George Brett",     "228", "Royals",    true,  true,  80,    300],
  [24, "baseball",   1975, "Topps",      "Robin Yount",      "223", "Brewers",   true,  true,  80,    300],
  [25, "baseball",   1979, "Topps",      "Ozzie Smith",      "116", "Padres",    true,  true,  80,    300],
  [26, "baseball",   1979, "Topps",      "Dale Murphy",      "39",  "Braves",    false, false, 5,     25],
  [27, "baseball",   1980, "Topps",      "Rickey Henderson", "482", "A's",       true,  true,  200,   700],
  [28, "baseball",   1984, "Topps",      "Don Mattingly",    "8",   "Yankees",   true,  false, 40,    150],
  [29, "baseball",   1990, "Topps",      "Frank Thomas",     "414", "White Sox", true,  true,  50,    200],
  [30, "baseball",   1951, "Bowman",     "Mickey Mantle",    "253", "Yankees",   true,  true,  25000, 100000],
  [31, "basketball", 1948, "Bowman",     "George Mikan",     "69",  "Lakers",    true,  true,  1500,  5000],
  [32, "baseball",   1933, "Goudey",     "Babe Ruth",        "149", "Yankees",   false, true,  8000,  25000],
  [33, "baseball",   1933, "Goudey",     "Lou Gehrig",       "92",  "Yankees",   false, true,  5000,  15000],
  [34, "baseball",   1933, "Goudey",     "Jimmie Foxx",      "154", "A's",       false, true,  1500,  5000],
  [35, "baseball",   1939, "Play Ball",  "Ted Williams",     "92",  "Red Sox",   true,  true,  5000,  15000],
  [36, "baseball",   1939, "Play Ball",  "Joe DiMaggio",     "26",  "Yankees",   false, true,  2000,  7000],
  [37, "baseball",   1989, "Upper Deck", "Ken Griffey Jr.",  "1",   "Mariners",  true,  true,  200,   800],
  [38, "baseball",   1989, "Upper Deck", "Randy Johnson",    "25",  "Expos",     true,  true,  30,    100],
  [39, "baseball",   1986, "Donruss",    "Jose Canseco",     "39",  "A's",       true,  false, 20,    80],
  [40, "hockey",     1979, "O-Pee-Chee", "Wayne Gretzky",    "18",  "Oilers",    true,  true,  8000,  25000],
  [41, "baseball",   1990, "Score",      "Barry Bonds",      "4",   "Pirates",   false, false, 5,     20],
  [42, "football",   1957, "Topps",      "Johnny Unitas",    "138", "Colts",     true,  true,  300,   1200],
  [43, "football",   1965, "Topps",      "Joe Namath",       "122", "Jets",      true,  true,  1500,  5000],
  [44, "football",   1965, "Topps",      "Gale Sayers",      "155", "Bears",     true,  true,  400,   1500],
  [45, "football",   1981, "Topps",      "Joe Montana",      "216", "49ers",     true,  true,  200,   800],
  [46, "football",   1989, "Score",      "Barry Sanders",    "257", "Lions",     true,  true,  40,    150],
  [47, "football",   1989, "Pro Set",    "Joe Montana",      "294", "49ers",     false, true,  5,     20],
  [48, "basketball", 1986, "Fleer",      "Michael Jordan",   "57",  "Bulls",     true,  true,  3000,  12000],
  [49, "basketball", 1986, "Fleer",      "Charles Barkley",  "115", "76ers",     true,  true,  50,    200],
  [50, "basketball", 1986, "Fleer",      "Hakeem Olajuwon",  "82",  "Rockets",   true,  true,  200,   800],
];

const SAMPLE_CARDS = SAMPLE_RAW.map((r, i) => {
  const card = {
    id: `sample-${i + 1}`,
    createdAt: { seconds: Math.floor(Date.now() / 1000) - 86400 * r[0] },
    imageFrontUrl: makeSampleImg(imgLabel(r[4])),
    identified: {
      sport: r[1],
      year: r[2],
      set: r[3],
      player: r[4],
      cardNumber: r[5],
      team: r[6],
      isRookie: r[7],
      isHOF: r[8],
      confidence: 0.9,
    },
    valueEstimate: { low: r[9], high: r[10], note: "Rough sample value." },
  };
  if (r[11]) card.userNotes = r[11];
  return card;
});

// A couple of sealed-product samples so the demo collection shows packs/boxes
// (and the item-type filter has something to filter).
SAMPLE_CARDS.push(
  {
    id: "sample-pack-1",
    createdAt: { seconds: Math.floor(Date.now() / 1000) - 86400 * 3 },
    itemType: "pack",
    imageFrontUrl: makeSampleImg("PACK"),
    identified: {
      sport: "baseball",
      year: 1987,
      set: "Topps",
      itemLabel: "Wax Pack",
      configuration: "17 cards + 1 stick of gum",
      sealed: true,
      notable: "Set includes Barry Bonds and Bo Jackson rookie cards.",
      confidence: 0.8,
    },
    valueEstimate: { low: 8, high: 30, note: "Rough sample value." },
  },
  {
    id: "sample-box-1",
    createdAt: { seconds: Math.floor(Date.now() / 1000) - 86400 * 6 },
    itemType: "box",
    imageFrontUrl: makeSampleImg("BOX"),
    identified: {
      sport: "basketball",
      year: 1986,
      set: "Fleer",
      itemLabel: "Wax Box",
      configuration: "36 wax packs, 12 cards each",
      sealed: true,
      notable: "The set famous for the Michael Jordan rookie card.",
      confidence: 0.6,
    },
    valueEstimate: { low: 50000, high: 250000, note: "Rough sample value." },
  },
);

// --- Routing ---------------------------------------------------------------
function showView(name) {
  let active = null;
  document.querySelectorAll(".view").forEach((v) => {
    const match = v.dataset.view === name;
    v.hidden = !match;
    if (match) active = v;
  });
  document.querySelectorAll(".navlink").forEach((a) => {
    a.classList.toggle("active", a.dataset.nav === name);
  });
  // a11y: move focus to the view's heading so screen-reader / keyboard users
  // land in the new view instead of being stranded where they were.
  focusViewHeading(active);
}

// Move focus to the first <h2> inside the given container (the active view).
// Used on every view change; result/detail re-render their innerHTML after
// showView, so those call focusHeadingEl again once their heading exists.
function focusViewHeading(container) {
  if (!container) return;
  focusHeadingEl(container.querySelector("h2"));
}

// Make an element programmatically focusable (tabindex=-1) and focus it.
// Detail content has no static <h2>, so callers pass its headline (.player).
function focusHeadingEl(h) {
  if (!h) return;
  if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
  try {
    h.focus({ preventScroll: false });
  } catch (_) {
    h.focus();
  }
}

function route() {
  const hash = location.hash || "#/scan";
  const isScan = hash === "#" || hash === "" || hash.startsWith("#/scan");
  if (!isScan) stopScanCamera();

  // Public share route: strip the owner's app chrome so a recipient only sees
  // the read-only gallery (handled via body.viewing-share in app.css).
  document.body.classList.toggle("viewing-share", hash.startsWith("#/share/"));

  if (hash.startsWith("#/share/")) {
    // Everything after "#/share/" is the token (it may legitimately contain no
    // slashes, but slice rather than split so an odd token isn't truncated).
    const token = hash.slice("#/share/".length);
    showView("share");
    renderSharedView(token);
  } else if (hash.startsWith("#/scan")) {
    showView("scan");
    showCameraStart();
  } else if (hash.startsWith("#/collection")) {
    showView("collection");
    renderCollection();
  } else if (hash.startsWith("#/detail/")) {
    const id = hash.split("/")[2];
    showView("detail");
    renderDetail(id);
  } else if (hash.startsWith("#/result")) {
    // Re-render from current state so a back/forward nav can't show stale DOM;
    // with nothing to show, fall back to the scan view.
    if (state.lastIdentified) {
      showView("result");
      renderResult(state.lastIdentified);
    } else {
      location.hash = "#/scan";
      return;
    }
  } else if (hash.startsWith("#/review/")) {
    const id = hash.split("/")[2];
    showView("review");
    renderReviewCard(id);
  } else if (hash.startsWith("#/review")) {
    showView("review");
    renderReview();
  } else if (hash.startsWith("#/locations")) {
    showView("locations");
    renderLocations();
  } else if (hash.startsWith("#/about")) {
    showView("about");
  } else if (hash.startsWith("#/guide")) {
    showView("guide");
  } else {
    showView("scan");
    showCameraStart();
  }
}
window.addEventListener("hashchange", route);

// --- Scan view -------------------------------------------------------------
const previewsEl = document.getElementById("scan-previews");
const identifyBtn = document.getElementById("identify-btn");
const scanStatus = document.getElementById("scan-status");
const resultNotesEl = document.getElementById("result-notes");
const captureFrontInput = document.getElementById("capture-front");
const captureBackInput = document.getElementById("capture-back");

// File-upload fallback (camera unavailable / blocked). The user picks a front
// (and optional back), then taps Identify — no auto-run, so the back isn't
// skipped.
captureFrontInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  // Multiple files selected, or bulk mode on → drop them all into the queue
  // instead of the single-card preview/Identify path.
  if (files.length > 1 || isBulkMode()) {
    files.forEach((f) => enqueueScan(f));
    captureFrontInput.value = "";
    scanStatus.textContent = `Added ${files.length} card${files.length > 1 ? "s" : ""} to the queue below.`;
    return;
  }
  state.frontFile = files[0];
  renderPreviews();
});

captureBackInput.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  state.backFile = f;
  renderPreviews();
});

// Item-type selector: card / pack / box. Sets state.itemType, which every new
// capture (live or upload) is tagged with so the Cloud Function uses the right
// identify prompt.
document.querySelectorAll(".itemtype-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.itemType = btn.dataset.itemtype;
    document.querySelectorAll(".itemtype-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    // Update the live-camera hint if the camera is already open.
    if (cameraStream) {
      setHint(`Scanning a ${itemNoun(state.itemType)} — fill the frame, then tap Capture.`);
    }
  });
});

// Human-readable nouns for the three item types.
function itemNoun(t) {
  return t === "pack" ? "sealed pack" : t === "box" ? "sealed box" : "card";
}

function renderPreviews() {
  // Revoke any object URLs from a previous render before creating new ones.
  previewUrls.forEach((u) => URL.revokeObjectURL(u));
  previewUrls = [];
  previewsEl.innerHTML = "";
  if (state.frontFile) {
    const img = document.createElement("img");
    img.alt = "Front";
    const u = URL.createObjectURL(state.frontFile);
    previewUrls.push(u);
    img.src = u;
    previewsEl.appendChild(img);
  }
  if (state.backFile) {
    const img = document.createElement("img");
    img.alt = "Back";
    const u = URL.createObjectURL(state.backFile);
    previewUrls.push(u);
    img.src = u;
    previewsEl.appendChild(img);
  }
  // The button is the manual trigger for the file-upload fallback; the live
  // autoscan path identifies on its own and navigates away.
  identifyBtn.hidden = !state.frontFile;
  identifyBtn.disabled = !state.frontFile;
}

identifyBtn.addEventListener("click", runIdentify);

async function runIdentify() {
  if (!state.frontFile) return;
  identifyBtn.disabled = true;
  scanStatus.textContent = "Looking at your card…";
  try {
    const result = await identifyCard(state.frontFile, state.backFile, state.itemType);
    state.lastIdentified = result;
    state.editingResult = false;
    state.reviewJobId = null;
    // Fresh manual identify — clear any notes carried over from a prior card
    // (mirrors reviewJob, which restores per-job notes instead).
    state.notes = "";
    resultNotesEl.value = "";
    renderResult(result);
    scanStatus.textContent = "";
    location.hash = "#/result";
  } catch (err) {
    console.error(err);
    // Drop back to the idle state so the user re-opens the camera to retry —
    // this also prevents a persistent failure from looping and hammering the API.
    if ((location.hash || "#/scan").startsWith("#/scan")) {
      showCameraStart();
    }
    scanStatus.textContent = "Couldn't identify that one. Tap Open camera to try again, or upload a photo.";
  } finally {
    identifyBtn.disabled = false;
  }
}

// --- Autoscan camera -------------------------------------------------------
// Live camera with a MANUAL shutter. The camera opens only when the user taps
// "Open camera," and a frame is grabbed only when they tap "Capture" — there is
// no automatic capture. Falls back to file upload when the camera is
// unavailable or permission is denied.
const cameraStage = document.getElementById("camera-stage");
const cameraVideo = document.getElementById("camera-video");
const cameraHint = document.getElementById("camera-hint");
const captureNowBtn = document.getElementById("capture-now-btn");
const enableCameraBtn = document.getElementById("enable-camera-btn");
const cameraFallback = document.getElementById("camera-fallback");

let cameraStream = null;
let capturing = false;          // guards against double-capture mid-identify

function camSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function setHint(text) {
  cameraHint.textContent = text;
  cameraHint.hidden = !text;
}

function showCameraFallback(msg) {
  cameraFallback.hidden = false;
  cameraFallback.open = true;
  captureNowBtn.hidden = true;
  if (msg) scanStatus.textContent = msg;
}

// Idle state for the scan view: camera OFF, "Open camera" button showing.
// The camera only starts when the user taps it — never automatically.
function showCameraStart() {
  stopScanCamera();
  hideSingleProcessing();
  renderTray();
  updateNavBadge();
  syncBulkLocationVisibility();
  refreshPendingCount();
  if (!camSupported()) {
    enableCameraBtn.hidden = true;
    showCameraFallback("This browser can't open the camera here. Upload a photo instead.");
    return;
  }
  cameraStage.hidden = true;
  captureNowBtn.hidden = true;
  enableCameraBtn.textContent = "Open camera";
  enableCameraBtn.hidden = false;
  cameraFallback.hidden = false;      // keep the upload escape hatch reachable
  scanStatus.textContent = "";
}

async function startScanCamera() {
  if (capturing) return;              // mid-identify; leave things alone
  if (!camSupported()) {
    cameraStage.hidden = true;
    showCameraFallback("This browser can't open the camera here. Upload a photo instead.");
    return;
  }
  if (cameraStream) {                 // already running
    captureNowBtn.hidden = false;
    return;
  }
  enableCameraBtn.hidden = true;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (err) {
    console.warn("getUserMedia failed:", err && err.name, err && err.message);
    cameraStage.hidden = true;
    if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      // Permission denied, or the browser wants a user gesture first.
      enableCameraBtn.hidden = false;
      showCameraFallback("Camera is blocked. Tap “Open camera,” or upload a photo.");
    } else {
      showCameraFallback("No camera available. Upload a photo instead.");
    }
    return;
  }
  cameraVideo.srcObject = cameraStream;
  try { await cameraVideo.play(); } catch (_) { /* autoplay attribute usually covers it */ }
  cameraStage.hidden = false;
  captureNowBtn.hidden = false;
  cameraFallback.hidden = false;      // keep the escape hatch reachable, collapsed
  scanStatus.textContent = "";
  setHint(
    isBulkMode()
      ? "Bulk mode — tap Capture for each card, one after another."
      : "Fill the frame with the card, then tap Capture",
  );
}

function stopScanCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  cameraVideo.srcObject = null;
  cameraStage.hidden = true;
  captureNowBtn.hidden = true;
}

async function captureFrameFile() {
  const vw = cameraVideo.videoWidth, vh = cameraVideo.videoHeight;
  const maxDim = 1600;
  const scale = Math.min(1, maxDim / Math.max(vw, vh));
  const w = Math.round(vw * scale), h = Math.round(vh * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(cameraVideo, 0, 0, w, h);
  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
  return new File([blob], "front.jpg", { type: "image/jpeg" });
}

async function captureAndIdentify() {
  if (capturing || !cameraStream) return;
  capturing = true;
  setHint("Got it!");
  let file;
  try {
    file = await captureFrameFile();
  } catch (err) {
    console.error("Frame capture failed", err);
    capturing = false;
    return;
  }
  const job = enqueueScan(file);
  if (isBulkMode()) {
    // Bulk mode: keep streaming, just confirm the grab and let it process.
    setHint(`Added ✓ — ${QUEUE.jobs.length} in queue. Snap the next card.`);
    capturing = false;
  } else {
    // Single mode: stop the camera and offer "wait here" vs "scan next."
    stopScanCamera();
    capturing = false;
    showSingleProcessing(job);
  }
}

captureNowBtn.addEventListener("click", () => {
  if (!capturing && cameraStream) captureAndIdentify();
});

enableCameraBtn.addEventListener("click", () => {
  enableCameraBtn.hidden = true;
  startScanCamera();
});

// Release the camera when the tab is hidden. On return, drop back to the
// idle "Open camera" state — never silently re-open the camera.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopScanCamera();
  } else if (!capturing && (location.hash || "#/scan").startsWith("#/scan")) {
    // A single-mode job is still in flight (its "Identifying…" panel is up and
    // will auto-open when ready) — don't wipe it by resetting to the camera.
    if (QUEUE.waitingJobId) return;
    showCameraStart();
  }
});

// --- Background scan queue --------------------------------------------------
// Each capture becomes a job that identifies in the background (no upload yet —
// the File is held in memory). A finished job waits as "ready" in the review
// tray; the image is only written to Storage/Firestore when the user confirms
// the card from the result view (so abandoned scans never leave orphans).
const scanProcessingEl = document.getElementById("scan-processing");
const scanQueueEl = document.getElementById("scan-queue");
const bulkToggleEl = document.getElementById("bulk-toggle");

// Bulk mode is read straight from the checkbox so the on-screen toggle and the
// capture behavior can never drift apart. A cached boolean used to desync from
// the DOM: browsers restore a checkbox's checked state across a reload (e.g. the
// service-worker auto-reload on deploy) WITHOUT firing a `change` event, which
// left the toggle visually ON while every capture still ran in single-card mode.
function isBulkMode() {
  return !!(bulkToggleEl && bulkToggleEl.checked);
}

const QUEUE = {
  jobs: [],            // { id, frontFile, backFile, thumbUrl, status, result, notes, error }
  active: 0,
  waitingJobId: null,  // single-mode: auto-open this job's result when it lands
  MAX: 3,              // cap concurrent identify calls (cost + load)
};

// How many pending (un-reviewed) cards exist in Firestore. Kept in a module
// variable so the nav badge and "Needs review" banners can render synchronously;
// refreshPendingCount() updates it from Firestore and re-paints those surfaces.
let pendingCount = 0;

async function refreshPendingCount() {
  if (!FIREBASE_READY || !currentUser) {
    pendingCount = 0;
    updateNavBadge();
    updateReviewSurfaces();
    return;
  }
  try {
    const snap = await getDocs(
      query(collection(db, "users", currentUser.uid, "cards"), where("status", "==", "pending")),
    );
    pendingCount = snap.size;
  } catch (err) {
    console.warn("Couldn't count pending cards", err);
  }
  updateNavBadge();
  updateReviewSurfaces();
}

function enqueueScan(frontFile, backFile = null) {
  const job = {
    id: crypto.randomUUID(),
    frontFile,
    backFile,
    itemType: state.itemType,   // tag the scan with whatever the selector was on
    thumbUrl: URL.createObjectURL(frontFile),
    status: "queued",      // queued → identifying → ready | error
    result: null,
    notes: "",
    error: null,
  };
  QUEUE.jobs.push(job);
  renderTray();
  updateNavBadge();
  pumpQueue();
  return job;
}

function pumpQueue() {
  while (QUEUE.active < QUEUE.MAX) {
    const next = QUEUE.jobs.find((j) => j.status === "queued");
    if (!next) break;
    runJob(next);
  }
}

async function runJob(job) {
  job.status = "identifying";
  QUEUE.active++;
  renderTray();
  // Tracks how this job ended so the finally block can route correctly:
  // "persisted" (saved as pending Firestore card), "ready" (in-memory demo
  // fallback), or "error".
  let outcome = null;
  let persistedCardId = null;
  let wasBulk = false;
  // Capture single-mode "waiting" intent up front: removeJob() (below) clears
  // QUEUE.waitingJobId, so we can't read it in the finally block to decide
  // whether to auto-open the review screen.
  let wasWaiting = QUEUE.waitingJobId === job.id;
  try {
    const result = await identifyCard(job.frontFile, job.backFile, job.itemType);
    if (!QUEUE.jobs.includes(job)) return; // discarded mid-flight
    job.result = result;

    // Durability: the moment we have an identify result, write it to Firestore
    // as a PENDING card (images uploaded first) so nothing is lost if the page
    // is discarded during review. Only when signed in — demo / pre-auth keeps
    // the in-memory "ready" + result-view Save fallback.
    if (FIREBASE_READY && currentUser) {
      wasBulk = isBulkMode();
      // Re-read in case the user tapped "Scan next" while identify was running.
      wasWaiting = QUEUE.waitingJobId === job.id;
      try {
        const cardId = await persistPendingCard(job);
        if (!QUEUE.jobs.includes(job)) return; // discarded mid-upload
        persistedCardId = cardId;
        outcome = "persisted";
        // It now lives in Firestore; drop it from the in-memory queue.
        removeJob(job.id);
      } catch (perr) {
        console.error("Persisting scan failed", perr);
        if (!QUEUE.jobs.includes(job)) return;
        // Keep the File in memory and let the user retry — never lose the scan.
        job.status = "error";
        job.error = perr;
        outcome = "error";
      }
    } else {
      job.status = "ready";
      outcome = "ready";
    }
  } catch (err) {
    console.error("Background identify failed", err);
    if (!QUEUE.jobs.includes(job)) return;
    job.status = "error";
    job.error = err;
    outcome = "error";
  } finally {
    QUEUE.active = Math.max(0, QUEUE.active - 1);
    renderTray();
    updateNavBadge();

    if (outcome === "persisted") {
      // Single-mode: take the user straight to the review screen for this card.
      // Bulk-mode: stay on the camera so they keep scanning; it waits in the pool.
      // (removeJob already cleared QUEUE.waitingJobId; wasWaiting was captured.)
      if (!wasBulk && wasWaiting) {
        hideSingleProcessing();
        location.hash = `#/review/${persistedCardId}`;
      }
    } else if (QUEUE.waitingJobId === job.id && QUEUE.jobs.includes(job)) {
      // Demo / in-memory fallback path: auto-open the result when ready.
      QUEUE.waitingJobId = null;
      if (job.status === "ready") reviewJob(job.id);
      else if (job.status === "error") showSingleError(job);
    }
    pumpQueue();
  }
}

// Upload a job's images and write a PENDING card doc. Returns the new cardId.
// Used by the background queue's success path so every identified scan is
// durable immediately (survives a page discard during review).
async function persistPendingCard(job) {
  const cardId = crypto.randomUUID();
  const frontUrl = await uploadImage(job.frontFile, cardId, "front");
  const backUrl = job.backFile ? await uploadImage(job.backFile, cardId, "back") : null;
  const result = job.result || {};
  await setDoc(doc(db, "users", currentUser.uid, "cards", cardId), {
    createdAt: serverTimestamp(),
    status: "pending",
    itemType: job.itemType || "card",
    imageFrontUrl: frontUrl,
    imageBackUrl: backUrl,
    identified: result.identified || {},
    valueEstimate: result.valueEstimate || null,
    ebayPrices: result.ebayPrices || null,
    locationId: state.bulkLocationId || null,
    userNotes: null,
  });
  return cardId;
}

function retryJob(id) {
  const job = QUEUE.jobs.find((j) => j.id === id);
  if (!job) return;
  job.status = "queued";
  job.error = null;
  renderTray();
  pumpQueue();
}

// Single point of removal for a queued job: revokes its thumbnail blob URL,
// clears the single-mode "waiting" pointer if it referenced this job, and drops
// it from the queue. Every code path that removes a job goes through here so a
// blob URL is never left dangling. Does NOT re-render — callers do that.
function removeJob(id) {
  const job = QUEUE.jobs.find((j) => j.id === id);
  if (!job) return;
  if (job.thumbUrl) URL.revokeObjectURL(job.thumbUrl);
  if (QUEUE.waitingJobId === id) QUEUE.waitingJobId = null;
  QUEUE.jobs = QUEUE.jobs.filter((j) => j.id !== id);
}

function discardJob(id) {
  if (!QUEUE.jobs.some((j) => j.id === id)) return;
  removeJob(id);
  renderTray();
  updateNavBadge();
}

// Load a "ready" job into the result view for confirm / edit / save.
function reviewJob(id) {
  const job = QUEUE.jobs.find((j) => j.id === id);
  if (!job || job.status !== "ready") return;
  hideSingleProcessing();
  state.frontFile = job.frontFile;
  state.backFile = job.backFile || null;
  state.lastIdentified = job.result;
  state.notes = job.notes || "";
  state.editingResult = false;
  state.reviewJobId = id;
  resultNotesEl.value = state.notes;
  renderResult(job.result);
  location.hash = "#/result";
}

// After saving a reviewed card, step to the next ready one (or leave the
// review flow). Used by the result-view Save button and "Review" tray button.
function reviewNext() {
  const next = QUEUE.jobs.find((j) => j.status === "ready");
  if (next) {
    reviewJob(next.id);
    return;
  }
  state.reviewJobId = null;
  resetScanInputs();
  // Still processing some? Send them back to the queue. Otherwise the collection.
  location.hash = QUEUE.jobs.length ? "#/scan" : "#/collection";
}

function renderTray() {
  if (!scanQueueEl) return;
  const jobs = QUEUE.jobs;
  if (!jobs.length) {
    scanQueueEl.hidden = true;
    scanQueueEl.innerHTML = "";
    return;
  }
  scanQueueEl.hidden = false;

  const working = jobs.filter((j) => j.status === "queued" || j.status === "identifying").length;
  const ready = jobs.filter((j) => j.status === "ready").length;
  const errored = jobs.filter((j) => j.status === "error").length;
  const parts = [];
  if (working) parts.push(`${working} identifying`);
  if (ready) parts.push(`${ready} ready to review`);
  if (errored) parts.push(`${errored} need a retry`);
  const summary = parts.join(" · ") || `${jobs.length} in queue`;

  scanQueueEl.innerHTML = `
    <div class="queue-head">
      <span class="queue-title">Scan queue</span>
      <span class="queue-summary">${esc(summary)}</span>
    </div>
    <div class="queue-items">
      ${jobs.map(renderJobChip).join("")}
    </div>
    ${ready ? `<button id="review-all-btn" class="big-button primary">Review ${ready} card${ready === 1 ? "" : "s"} &rarr;</button>` : ""}
  `;
  const reviewAll = document.getElementById("review-all-btn");
  if (reviewAll) reviewAll.addEventListener("click", reviewNext);
}

function renderJobChip(job) {
  let label;
  if (job.status === "ready") label = displayName(job.result) || "Tap to review";
  else if (job.status === "error") label = "Tap to retry";
  else label = "Identifying…";
  return `
    <div class="queue-chip qchip-${job.status}" data-job="${esc(job.id)}" role="button" tabindex="0" title="${esc(label)}">
      <img src="${esc(job.thumbUrl)}" alt="" />
      <span class="queue-chip-status" aria-hidden="true"></span>
      <button class="queue-chip-x" data-discard="${esc(job.id)}" aria-label="Remove from queue">×</button>
      <span class="queue-chip-label">${esc(label)}</span>
    </div>
  `;
}

// Delegated tray interactions (the container persists across re-renders).
if (scanQueueEl) {
  scanQueueEl.addEventListener("click", (e) => {
    const x = e.target.closest("[data-discard]");
    if (x) {
      e.stopPropagation();
      discardJob(x.dataset.discard);
      return;
    }
    const chip = e.target.closest("[data-job]");
    if (!chip) return;
    const job = QUEUE.jobs.find((j) => j.id === chip.dataset.job);
    if (!job) return;
    if (job.status === "ready") reviewJob(job.id);
    else if (job.status === "error") retryJob(job.id);
  });

  // Keyboard activation: the chips are role=button tabindex=0, so Enter/Space
  // must do what a click does (review if ready / retry if error).
  scanQueueEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const chip = e.target.closest("[data-job]");
    if (!chip) return;
    if (e.key === " " || e.key === "Spacebar") e.preventDefault(); // avoid page scroll
    const job = QUEUE.jobs.find((j) => j.id === chip.dataset.job);
    if (!job) return;
    if (job.status === "ready") reviewJob(job.id);
    else if (job.status === "error") retryJob(job.id);
  });
}

// Single-mode panel shown right after a capture: wait, or move on.
function showSingleProcessing(job) {
  if (!scanProcessingEl) return;
  QUEUE.waitingJobId = job.id; // auto-open when this one is ready
  // Announce the Identifying…/ready/error transitions to screen readers.
  scanProcessingEl.setAttribute("aria-live", "polite");
  scanProcessingEl.setAttribute("aria-atomic", "true");
  scanProcessingEl.hidden = false;
  scanProcessingEl.innerHTML = `
    <div class="processing-card">
      <img src="${esc(job.thumbUrl)}" alt="" class="processing-thumb" />
      <div class="processing-body">
        <div class="processing-spinner" aria-hidden="true"></div>
        <p class="processing-title">Identifying your card…</p>
        <p class="processing-sub">Wait here and it opens when ready, or scan the next card while this finishes.</p>
        <button id="scan-next-btn" class="big-button">Scan next card &rarr;</button>
      </div>
    </div>
  `;
  document.getElementById("scan-next-btn").addEventListener("click", () => {
    QUEUE.waitingJobId = null; // it stays in the tray as "ready" for later
    hideSingleProcessing();
    startScanCamera();
  });
}

function showSingleError(job) {
  if (!scanProcessingEl) return;
  scanProcessingEl.hidden = false;
  scanProcessingEl.innerHTML = `
    <div class="processing-card error">
      <img src="${esc(job.thumbUrl)}" alt="" class="processing-thumb" />
      <div class="processing-body">
        <p class="processing-title">Couldn't identify that one.</p>
        <p class="processing-sub">The photo may be blurry, or the network dropped.</p>
        <div class="row">
          <button id="proc-retry" class="big-button primary">Try again</button>
          <button id="proc-discard" class="big-button">Discard</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("proc-retry").addEventListener("click", () => {
    retryJob(job.id);
    showSingleProcessing(job);
  });
  document.getElementById("proc-discard").addEventListener("click", () => {
    hideSingleProcessing();
    discardJob(job.id);
    showCameraStart();
  });
}

function hideSingleProcessing() {
  if (!scanProcessingEl) return;
  scanProcessingEl.hidden = true;
  scanProcessingEl.innerHTML = "";
}

// Reset the single-card scan inputs (shared by Re-scan and post-save cleanup).
function resetScanInputs() {
  state.frontFile = null;
  state.backFile = null;
  state.lastIdentified = null;
  state.notes = "";
  state.editingResult = false;
  resultNotesEl.value = "";
  // Drop any preview object URLs so they don't leak across a reset.
  previewUrls.forEach((u) => URL.revokeObjectURL(u));
  previewUrls = [];
  renderPreviews();
  captureFrontInput.value = "";
  captureBackInput.value = "";
  scanStatus.textContent = "";
}

// Keep the result view's Save / Re-scan buttons labelled for the active context.
function syncResultButtons() {
  const save = document.getElementById("save-btn");
  const rescan = document.getElementById("rescan-btn");
  if (!save || !rescan) return;
  if (state.reviewJobId) {
    const moreReady = QUEUE.jobs.some((j) => j.status === "ready" && j.id !== state.reviewJobId);
    save.textContent = moreReady ? "Save & next" : "Save to collection";
    rescan.textContent = "Discard";
  } else {
    save.textContent = "Save to collection";
    rescan.textContent = "Re-scan";
  }
}

// Badge on the Scan nav tab: in-flight queue jobs still identifying/errored.
// (Pending cards now live in Firestore and get their own Review-tab badge.)
function updateNavBadge() {
  setNavBadge("scan", QUEUE.jobs.length);
  setNavBadge("review", pendingCount);
}

// Set/clear a count badge on a given bottom-nav link.
function setNavBadge(nav, n) {
  const link = document.querySelector(`.navlink[data-nav="${nav}"]`);
  if (!link) return;
  let badge = link.querySelector(".nav-badge");
  if (!n) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "nav-badge";
    link.appendChild(badge);
  }
  badge.textContent = String(n);
}

// Show/update the "Needs review (N)" banners on the Scan and Collection views.
// Hidden when there's nothing pending. Built into containers added in index.html.
function updateReviewSurfaces() {
  document.querySelectorAll(".review-cta").forEach((el) => {
    if (pendingCount > 0) {
      el.hidden = false;
      el.innerHTML = `<a href="#/review" class="review-cta-link">Needs review (${pendingCount}) &rarr;</a>`;
    } else {
      el.hidden = true;
      el.innerHTML = "";
    }
  });
}

if (bulkToggleEl) {
  bulkToggleEl.addEventListener("change", () => {
    syncBulkLocationVisibility();
    if (isBulkMode()) {
      hideSingleProcessing();
      if (camSupported() && !cameraStream) startScanCamera();
      else if (cameraStream) setHint("Bulk mode on — tap Capture for each card.");
    }
  });
}

// --- Bulk-mode location picker ---------------------------------------------
// Only shown in Bulk mode. Lets the user pick one location once; every pending
// card persisted while bulk is on inherits it (state.bulkLocationId).
const bulkLocationWrap = document.getElementById("bulk-location-wrap");
const bulkLocationSelect = document.getElementById("bulk-location");
const bulkNewLocationBtn = document.getElementById("bulk-new-location");

// Show the picker in bulk mode (and populate it); hide it otherwise.
function syncBulkLocationVisibility() {
  if (!bulkLocationWrap) return;
  if (isBulkMode()) {
    bulkLocationWrap.hidden = false;
    populateBulkLocationSelect();
  } else {
    bulkLocationWrap.hidden = true;
  }
}

// Fill the bulk-location <select> from locationsCache, preserving the current
// pick. Loads locations from Firestore first if the cache is empty.
async function populateBulkLocationSelect() {
  if (!bulkLocationSelect) return;
  if (FIREBASE_READY && currentUser && locationsCache.length === 0) {
    await loadLocations();
  }
  const current = state.bulkLocationId || "";
  const opts = [
    `<option value="">— No location —</option>`,
    ...locationsCache.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`),
  ];
  bulkLocationSelect.innerHTML = opts.join("");
  // Keep the selection only if it still resolves to an existing location.
  const stillValid = current === "" || locationsCache.some((l) => l.id === current);
  state.bulkLocationId = stillValid && current ? current : null;
  bulkLocationSelect.value = state.bulkLocationId || "";
}

if (bulkLocationSelect) {
  bulkLocationSelect.addEventListener("change", () => {
    state.bulkLocationId = bulkLocationSelect.value || null;
  });
}

if (bulkNewLocationBtn) {
  bulkNewLocationBtn.addEventListener("click", async () => {
    if (IS_DEMO || !currentUser) {
      showToast("Sign in to add locations.", { variant: "error" });
      return;
    }
    const raw = await promptDialog({ title: "New location", label: 'Location name (e.g. "Binder A — Page 3")', placeholder: "Binder A — Page 3", confirmLabel: "Add" });
    if (raw == null) return;
    const name = raw.trim();
    if (!name) return;
    try {
      const id = crypto.randomUUID();
      await setDoc(doc(db, "users", currentUser.uid, "locations", id), {
        name,
        createdAt: serverTimestamp(),
      });
      locationsCache.push({ id, name });
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      bulkLocationSelect.appendChild(opt);
      bulkLocationSelect.value = id;
      state.bulkLocationId = id;
    } catch (err) {
      console.error(err);
      showToast("Couldn't add that location. Try again.", { variant: "error" });
    }
  });
}

resultNotesEl.addEventListener("input", (e) => {
  state.notes = e.target.value;
  refreshResultEbayContent();
});

// --- Identify --------------------------------------------------------------
async function identifyCard(frontFile, backFile, itemType = "card") {
  if (USE_MOCK_AI || !FIREBASE_READY || !currentUser) {
    return mockIdentify(itemType);
  }
  const frontImageBase64 = await fileToShrunkBase64(frontFile);
  const backImageBase64 = backFile ? await fileToShrunkBase64(backFile) : null;
  const callable = httpsCallable(functions, "identifyCard");
  const res = await callable({ frontImageBase64, backImageBase64, itemType });
  return res.data;
}

async function mockIdentify(itemType = "card") {
  await new Promise((r) => setTimeout(r, 800));
  if (itemType === "pack") {
    return {
      itemType: "pack",
      identified: {
        sport: "baseball",
        year: 1987,
        set: "Topps",
        itemLabel: "Wax Pack",
        configuration: "17 cards + 1 stick of gum",
        sealed: true,
        notable: "Set includes Barry Bonds and Bo Jackson rookie cards.",
        confidence: 0.78,
      },
      valueEstimate: {
        low: 8,
        high: 30,
        note: "Rough estimate for a sealed pack. Authenticity and seal matter a lot — verify with recent eBay sold listings.",
        estimatedAt: new Date().toISOString(),
      },
    };
  }
  if (itemType === "box") {
    return {
      itemType: "box",
      identified: {
        sport: "basketball",
        year: 1986,
        set: "Fleer",
        itemLabel: "Wax Box",
        configuration: "36 wax packs, 12 cards + 1 sticker each",
        sealed: true,
        notable: "The set famous for the Michael Jordan rookie card.",
        confidence: 0.7,
      },
      valueEstimate: {
        low: 50000,
        high: 250000,
        note: "Rough estimate for a sealed box. Authenticity and seal matter a lot — verify with recent eBay sold listings.",
        estimatedAt: new Date().toISOString(),
      },
    };
  }
  return {
    itemType: "card",
    identified: {
      sport: "baseball",
      year: 1956,
      set: "Topps",
      player: "Mickey Mantle",
      cardNumber: "135",
      team: "Yankees",
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

// --- Item-type-aware rendering helpers -------------------------------------
function itemTypeOf(data) {
  return data?.itemType === "pack" || data?.itemType === "box" ? data.itemType : "card";
}

// The headline name shown in chips, the collection, and result/detail views.
function displayName(data) {
  const id = data?.identified || {};
  const t = itemTypeOf(data);
  if (t === "pack") return id.itemLabel || "Card pack";
  if (t === "box") return id.itemLabel || "Card box";
  return id.player || "Unknown";
}

// Small secondary line under each collection tile.
function collectionCardSub(c) {
  const id = c?.identified || {};
  if (itemTypeOf(c) === "card") return id.cardNumber ? `#${esc(id.cardNumber)}` : "";
  return id.sealed ? "Sealed" : "";
}

// Headline + meta + badges (+ configuration/notable for sealed product),
// shared by the result and detail views so both render every type the same way.
function identifiedSummaryHTML(data) {
  const id = data.identified || {};
  const t = itemTypeOf(data);
  if (t === "pack" || t === "box") {
    const typeWord = t === "pack" ? "Sealed pack" : "Sealed box";
    return `
      <p class="player">${esc(displayName(data))}</p>
      <p class="meta">${id.year ?? ""} ${esc(id.set || "")} &mdash; ${esc(capSport(id.sport) || "")}</p>
      <div class="badges">
        <span class="badge type">${typeWord}</span>
        ${id.sealed ? `<span class="badge sealed">Looks sealed</span>` : ""}
        ${typeof id.confidence === "number" ? `<span class="badge">Confidence ${Math.round(id.confidence * 100)}%</span>` : ""}
      </div>
      ${id.configuration ? `<p class="item-extra"><strong>What's inside:</strong> ${esc(id.configuration)}</p>` : ""}
      ${id.notable ? `<p class="item-extra">${esc(id.notable)}</p>` : ""}
    `;
  }
  return `
    <p class="player">${esc(displayName(data))}</p>
    <p class="meta">${id.year ?? ""} ${esc(id.set || "")} ${id.cardNumber ? `#${esc(id.cardNumber)}` : ""} &mdash; ${esc(capSport(id.sport) || "")}</p>
    <div class="badges">
      ${id.isRookie ? `<span class="badge rookie">Rookie</span>` : ""}
      ${id.isHOF ? `<span class="badge hof">Hall of Fame</span>` : ""}
      ${typeof id.confidence === "number" ? `<span class="badge">Confidence ${Math.round(id.confidence * 100)}%</span>` : ""}
    </div>
  `;
}

// --- Result view -----------------------------------------------------------
function renderResult(data) {
  if (state.editingResult) {
    renderResultEditForm();
    return;
  }
  const { identified, valueEstimate } = data;
  const el = document.getElementById("result-card");
  const highValue = (valueEstimate?.high || 0) >= HIGH_VALUE_THRESHOLD;
  const uncertain = (identified.confidence || 0) < 0.5;
  const inReview = !!state.reviewJobId;
  const moreReady = inReview
    ? QUEUE.jobs.filter((j) => j.status === "ready" && j.id !== state.reviewJobId).length
    : 0;

  el.innerHTML = `
    ${inReview ? `<div class="review-banner">Reviewing an item from your scan queue.${moreReady ? ` ${moreReady} more ready after this.` : ""} Save it to your collection or discard it.</div>` : ""}
    ${highValue ? `<div class="high-value-banner">This could be worth a closer look — see the Guide before you sell, clean, or grade it.</div>` : ""}
    ${uncertain ? `<div class="uncertain-banner">I'm not very sure about this one. Does it look right? Tap <strong>Edit details</strong> below to fix anything.</div>` : ""}
    ${identifiedSummaryHTML(data)}
    <div class="value-block">
      <div class="label muted">Claude AI ballpark</div>
      <div class="range">$${fmt(valueEstimate?.low || 0)} &ndash; $${fmt(valueEstimate?.high || 0)}</div>
      <div class="note">${esc(valueEstimate?.note || "")}</div>
    </div>
    ${renderEbayBlock(data.ebayPrices)}
    ${renderPriceLinks(data)}
    <button id="edit-details-btn" class="link-button" style="margin-top: 10px;">Edit details</button>
    ${ebaySectionHTML({ ...data, userNotes: state.notes })}
  `;

  document.getElementById("edit-details-btn").addEventListener("click", () => {
    state.editingResult = true;
    renderResult(state.lastIdentified);
  });

  syncResultButtons();
}

function renderResultEditForm() {
  const id = state.lastIdentified.identified || {};
  const el = document.getElementById("result-card");
  const type = itemTypeOf(state.lastIdentified);
  el.innerHTML =
    renderEditFormHTML(id, type) +
    `<div class="row">
       <button id="apply-edits-btn" class="big-button primary">Save changes</button>
       <button id="cancel-edits-btn" class="big-button">Cancel</button>
     </div>`;

  document.getElementById("apply-edits-btn").addEventListener("click", () => {
    state.lastIdentified.identified = {
      ...state.lastIdentified.identified,
      ...readEditFormValues(type),
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

function sportSelectHTML(identified) {
  const sports = ["baseball", "football", "basketball", "hockey", "other"];
  return `
    <label>Sport
      <select id="ed-sport">
        ${sports
          .map(
            (s) =>
              `<option value="${s}" ${identified.sport === s ? "selected" : ""}>${s[0].toUpperCase()}${s.slice(1)}</option>`,
          )
          .join("")}
      </select>
    </label>`;
}

function renderEditFormHTML(identified, itemType = "card") {
  if (itemType === "pack" || itemType === "box") {
    const word = itemType === "pack" ? "pack" : "box";
    return `
      <p class="edit-title">Edit ${word} details</p>
      <div class="edit-form">
        <label>Product label
          <input id="ed-itemLabel" type="text" value="${esc(identified.itemLabel || "")}" placeholder="e.g. Wax ${word === "pack" ? "Pack" : "Box"}, Hobby Box" autocomplete="off" />
        </label>
        <label>Year
          <input id="ed-year" type="number" value="${identified.year || ""}" min="1880" max="2030" inputmode="numeric" />
        </label>
        <label>Set / Manufacturer
          <input id="ed-set" type="text" value="${esc(identified.set || "")}" placeholder="e.g. Topps, Fleer, Upper Deck" autocomplete="off" />
        </label>
        ${sportSelectHTML(identified)}
        <label>What's inside
          <input id="ed-configuration" type="text" value="${esc(identified.configuration || "")}" placeholder="e.g. 36 packs, 15 cards each" autocomplete="off" />
        </label>
        <label>Notes about this product
          <input id="ed-notable" type="text" value="${esc(identified.notable || "")}" placeholder="e.g. has the MJ rookie" autocomplete="off" />
        </label>
        <label class="checkbox">
          <input id="ed-sealed" type="checkbox" ${identified.sealed ? "checked" : ""} />
          <span>Appears factory sealed / unopened</span>
        </label>
      </div>
    `;
  }
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
      <label>Team
        <input id="ed-team" type="text" value="${esc(identified.team || "")}" placeholder="e.g. Yankees, Bulls (optional)" autocomplete="off" />
      </label>
      ${sportSelectHTML(identified)}
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

function readEditFormValues(itemType = "card") {
  const yearRaw = parseInt(document.getElementById("ed-year").value, 10);
  const year = Number.isFinite(yearRaw) ? yearRaw : null;
  const sport = document.getElementById("ed-sport").value;
  if (itemType === "pack" || itemType === "box") {
    return {
      itemLabel: document.getElementById("ed-itemLabel").value.trim(),
      year,
      set: document.getElementById("ed-set").value.trim(),
      sport,
      configuration: document.getElementById("ed-configuration").value.trim() || null,
      notable: document.getElementById("ed-notable").value.trim() || null,
      sealed: document.getElementById("ed-sealed").checked,
    };
  }
  return {
    player: document.getElementById("ed-player").value.trim(),
    year,
    set: document.getElementById("ed-set").value.trim(),
    cardNumber: document.getElementById("ed-cardNumber").value.trim(),
    team: document.getElementById("ed-team").value.trim() || null,
    sport,
    isRookie: document.getElementById("ed-isRookie").checked,
    isHOF: document.getElementById("ed-isHOF").checked,
  };
}

document.getElementById("rescan-btn").addEventListener("click", () => {
  // In review context this button is "Discard": drop the queued job, then move
  // on to the next ready card (or back to the camera if none are waiting).
  if (state.reviewJobId) {
    const id = state.reviewJobId;
    state.reviewJobId = null;
    discardJob(id);
    resetScanInputs();
    const next = QUEUE.jobs.find((j) => j.status === "ready");
    if (next) reviewJob(next.id);
    else location.hash = "#/scan";
    return;
  }
  resetScanInputs();
  location.hash = "#/scan";
});

document.getElementById("save-btn").addEventListener("click", async () => {
  if (!state.lastIdentified) return;
  if (!FIREBASE_READY || !currentUser) {
    showToast("Firebase isn't connected yet. Card not saved (demo mode).", { variant: "info" });
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
      itemType: state.lastIdentified.itemType || "card",
      imageFrontUrl: frontUrl,
      imageBackUrl: backUrl,
      identified: state.lastIdentified.identified || {},
      valueEstimate: state.lastIdentified.valueEstimate || null,
      ebayPrices: state.lastIdentified.ebayPrices || null,
      userNotes: state.notes || null,
    });
    if (state.reviewJobId) {
      // Saved a queued card: remove it (revoking its blob) and step to the next.
      const savedId = state.reviewJobId;
      state.reviewJobId = null;
      removeJob(savedId);
      renderTray();
      updateNavBadge();
      reviewNext();
    } else {
      resetScanInputs();
      location.hash = "#/collection";
    }
  } catch (err) {
    console.error(err);
    showToast("Save failed. Try again.", { variant: "error" });
  } finally {
    saveBtn.disabled = false;
    syncResultButtons();
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
const sortSelectEl = document.getElementById("collection-sort");
const filtersToggleEl = document.getElementById("filters-toggle");
const filtersPanelEl = document.getElementById("filters-panel");
const filterSportEl = document.getElementById("filter-sport");
const filterItemTypeEl = document.getElementById("filter-itemtype");
// Declared here (not in the Locations section) so the collection-control wiring
// below can reference it without hitting a temporal-dead-zone error at load.
const filterLocationEl = document.getElementById("filter-location");
const filterRookieEl = document.getElementById("filter-rookie");
const filterHofEl = document.getElementById("filter-hof");
const filterYearFromEl = document.getElementById("filter-year-from");
const filterYearToEl = document.getElementById("filter-year-to");
const filtersClearEl = document.getElementById("filters-clear");
const exportCsvEl = document.getElementById("export-csv");

let cardsCache = [];

async function renderCollection() {
  if (IS_DEMO) {
    cardsCache = SAMPLE_CARDS.slice();
    locationsCache = [];
    drawCollection();
    return;
  }
  // Production, auth still resolving: show a neutral loading state rather than
  // flashing the sample cards as if they were the user's own. onAuthStateChanged
  // calls route() once sign-in completes, which re-renders this view.
  if (!currentUser) {
    cardsCache = [];
    locationsCache = [];
    collectionListEl.innerHTML = "";
    collectionTotalEl.textContent = "";
    collectionEmptyEl.innerHTML = `<p>Loading your collection…</p>`;
    collectionEmptyEl.hidden = false;
    return;
  }
  await loadLocations();
  const snap = await getDocs(
    query(collection(db, "users", currentUser.uid, "cards"), orderBy("createdAt", "desc")),
  );
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // Collection = KEPT only. Pending cards (still in the review pool) are hidden;
  // legacy cards with no status field are treated as kept.
  cardsCache = all.filter((c) => c.status !== "pending");
  // Surface the review pool from the same read (no extra query).
  pendingCount = all.filter((c) => c.status === "pending").length;
  updateNavBadge();
  updateReviewSurfaces();
  drawCollection();
}

const sortComparators = {
  newest: (a, b) => tsMs(b.createdAt) - tsMs(a.createdAt),
  oldest: (a, b) => tsMs(a.createdAt) - tsMs(b.createdAt),
  // Sort by the HIGH end of the value range (the optimistic estimate).
  "high-desc": (a, b) => (b.valueEstimate?.high || 0) - (a.valueEstimate?.high || 0),
  "high-asc": (a, b) => (a.valueEstimate?.high || 0) - (b.valueEstimate?.high || 0),
  // Sort by the LOW end of the value range (the conservative estimate).
  "low-desc": (a, b) => (b.valueEstimate?.low || 0) - (a.valueEstimate?.low || 0),
  "low-asc": (a, b) => (a.valueEstimate?.low || 0) - (b.valueEstimate?.low || 0),
  "newest-cards": (a, b) => (b.identified?.year || 0) - (a.identified?.year || 0),
  "oldest-cards": (a, b) => (a.identified?.year || 9999) - (b.identified?.year || 9999),
  "player-az": (a, b) =>
    (a.identified?.player || a.identified?.itemLabel || "").localeCompare(
      b.identified?.player || b.identified?.itemLabel || "",
    ),
};

function applyFiltersAndSort(cards) {
  const term = (collectionSearchEl.value || "").trim().toLowerCase();
  const f = collectionFilters;
  const filtered = cards.filter((c) => {
    if (term) {
      const haystack = `${c.identified?.player || ""} ${c.identified?.itemLabel || ""} ${c.identified?.year || ""} ${c.identified?.set || ""} ${c.identified?.team || ""}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    if (f.itemType !== "all" && itemTypeOf(c) !== f.itemType) return false;
    if (f.sport !== "all" && c.identified?.sport !== f.sport) return false;
    if (f.location !== "all") {
      // A card counts as "assigned" only if its locationId still resolves to an
      // existing location — a dangling id (location since deleted) is unassigned.
      const resolved = !!c.locationId && locationsCache.some((l) => l.id === c.locationId);
      if (f.location === "none" && resolved) return false;
      if (f.location !== "none" && c.locationId !== f.location) return false;
    }
    if (f.rookieOnly && !c.identified?.isRookie) return false;
    if (f.hofOnly && !c.identified?.isHOF) return false;
    const y = c.identified?.year;
    if (f.yearFrom !== null && (typeof y !== "number" || y < f.yearFrom)) return false;
    if (f.yearTo !== null && (typeof y !== "number" || y > f.yearTo)) return false;
    return true;
  });
  const cmp = sortComparators[f.sort] || sortComparators.newest;
  return filtered.slice().sort(cmp);
}

function drawCollection() {
  populateLocationFilter();
  const filtered = applyFiltersAndSort(cardsCache);
  ensureDemoBanner();

  const totalLow = cardsCache.reduce((s, c) => s + (c.valueEstimate?.low || 0), 0);
  const totalHigh = cardsCache.reduce((s, c) => s + (c.valueEstimate?.high || 0), 0);
  if (cardsCache.length === 0) {
    collectionTotalEl.textContent = "";
  } else if (filtered.length === cardsCache.length) {
    collectionTotalEl.textContent = `${cardsCache.length} cards • $${fmt(totalLow)}–$${fmt(totalHigh)} est.`;
  } else {
    collectionTotalEl.textContent = `${filtered.length} of ${cardsCache.length} cards`;
  }

  if (cardsCache.length === 0) {
    collectionEmptyEl.innerHTML = `
      <p>No cards yet. Scan one to get started.</p>
      <a href="#/scan" class="big-button primary cta">Scan your first card</a>
    `;
    collectionEmptyEl.hidden = false;
  } else if (filtered.length === 0) {
    collectionEmptyEl.innerHTML = `
      <p>No cards match those filters.</p>
      <button id="empty-clear" type="button" class="link-button">Clear all filters</button>
    `;
    collectionEmptyEl.hidden = false;
    document.getElementById("empty-clear").addEventListener("click", clearAllFilters);
  } else {
    collectionEmptyEl.hidden = true;
  }

  collectionListEl.innerHTML = renderGroupedHTML(filtered);
}

// Hierarchical Manufacturer → Year → Team grouping.
// Cards within each leaf are kept in the order applyFiltersAndSort returned,
// and group keys are iterated in insertion order — so the chosen sort
// cascades naturally through every level (manufacturers / years / teams all
// re-order based on their highest-ranked card under the active sort).
function renderGroupedHTML(cards) {
  if (cards.length === 0) return "";

  const groups = new Map();
  for (const c of cards) {
    const mfr = (c.identified?.set || "").trim() || "(Unknown manufacturer)";
    const year = c.identified?.year || "(Unknown year)";
    // Cards bucket by team; sealed packs/boxes bucket by their product label.
    const team =
      itemTypeOf(c) === "card"
        ? (c.identified?.team || "").trim() || "(Unknown team)"
        : (c.identified?.itemLabel || "").trim() || (itemTypeOf(c) === "pack" ? "Sealed packs" : "Sealed boxes");
    if (!groups.has(mfr)) groups.set(mfr, new Map());
    const mfrMap = groups.get(mfr);
    if (!mfrMap.has(year)) mfrMap.set(year, new Map());
    const yearMap = mfrMap.get(year);
    if (!yearMap.has(team)) yearMap.set(team, []);
    yearMap.get(team).push(c);
  }

  const mfrs = [...groups.keys()];
  return mfrs
    .map((mfr) => {
      const mfrMap = groups.get(mfr);
      const years = [...mfrMap.keys()];
      const mfrCount = years.reduce(
        (sum, y) => sum + [...mfrMap.get(y).values()].reduce((s, arr) => s + arr.length, 0),
        0,
      );
      return `
        <details class="group group-mfr" open>
          <summary class="group-summary">
            <span class="group-name">${esc(mfr)}</span>
            <span class="group-count">${mfrCount}</span>
          </summary>
          ${years
            .map((year) => {
              const yearMap = mfrMap.get(year);
              const teams = [...yearMap.keys()];
              const yearCount = [...yearMap.values()].reduce((s, arr) => s + arr.length, 0);
              return `
                <details class="group group-year" open>
                  <summary class="group-summary">
                    <span class="group-name">${esc(year)}</span>
                    <span class="group-count">${yearCount}</span>
                  </summary>
                  ${teams
                    .map((team) => {
                      const teamCards = yearMap.get(team);
                      return `
                        <details class="group group-team" open>
                          <summary class="group-summary">
                            <span class="group-name">${esc(team)}</span>
                            <span class="group-count">${teamCards.length}</span>
                          </summary>
                          <div class="group-cards">
                            ${teamCards
                              .map(
                                (c) => `
                              <a class="collection-card" href="#/detail/${esc(c.id)}">
                                <img src="${esc(c.imageFrontUrl || "")}" alt="${esc(displayName(c))}" />
                                <div class="info">
                                  <div class="name">${esc(displayName(c))}</div>
                                  <div class="sub">${collectionCardSub(c)}</div>
                                  <div class="price">$${fmt(c.valueEstimate?.low || 0)}–$${fmt(c.valueEstimate?.high || 0)}</div>
                                </div>
                              </a>`,
                              )
                              .join("")}
                          </div>
                        </details>`;
                    })
                    .join("")}
                </details>`;
            })
            .join("")}
        </details>`;
    })
    .join("");
}

function ensureDemoBanner() {
  const existing = document.getElementById("demo-banner");
  if (IS_DEMO) {
    if (!existing) {
      const banner = document.createElement("div");
      banner.id = "demo-banner";
      banner.className = "demo-banner";
      banner.innerHTML =
        "Showing <strong>sample cards</strong> so you can try search and filters. Your real saved cards will appear here once Firebase is connected.";
      collectionListEl.parentNode.insertBefore(banner, collectionListEl);
    }
  } else if (existing) {
    existing.remove();
  }
}

function clearAllFilters() {
  collectionFilters.sport = "all";
  collectionFilters.itemType = "all";
  collectionFilters.location = "all";
  collectionFilters.rookieOnly = false;
  collectionFilters.hofOnly = false;
  collectionFilters.yearFrom = null;
  collectionFilters.yearTo = null;
  filterSportEl.value = "all";
  if (filterItemTypeEl) filterItemTypeEl.value = "all";
  if (filterLocationEl) filterLocationEl.value = "all";
  filterRookieEl.checked = false;
  filterHofEl.checked = false;
  filterYearFromEl.value = "";
  filterYearToEl.value = "";
  drawCollection();
}

// Collection control wiring
collectionSearchEl.addEventListener("input", drawCollection);

sortSelectEl.addEventListener("change", () => {
  collectionFilters.sort = sortSelectEl.value;
  drawCollection();
});

// a11y: announce the collapsed/expanded state of the filters panel.
filtersToggleEl.setAttribute("aria-controls", "filters-panel");
filtersToggleEl.setAttribute("aria-expanded", "false");
filtersToggleEl.addEventListener("click", () => {
  filtersPanelEl.hidden = !filtersPanelEl.hidden;
  filtersToggleEl.classList.toggle("active", !filtersPanelEl.hidden);
  filtersToggleEl.setAttribute("aria-expanded", String(!filtersPanelEl.hidden));
});

filterSportEl.addEventListener("change", () => {
  collectionFilters.sport = filterSportEl.value;
  drawCollection();
});
if (filterItemTypeEl) {
  filterItemTypeEl.addEventListener("change", () => {
    collectionFilters.itemType = filterItemTypeEl.value;
    drawCollection();
  });
}
if (filterLocationEl) {
  filterLocationEl.addEventListener("change", () => {
    collectionFilters.location = filterLocationEl.value;
    drawCollection();
  });
}
filterRookieEl.addEventListener("change", () => {
  collectionFilters.rookieOnly = filterRookieEl.checked;
  drawCollection();
});
filterHofEl.addEventListener("change", () => {
  collectionFilters.hofOnly = filterHofEl.checked;
  drawCollection();
});
filterYearFromEl.addEventListener("input", () => {
  const v = parseInt(filterYearFromEl.value, 10);
  collectionFilters.yearFrom = Number.isFinite(v) ? v : null;
  drawCollection();
});
filterYearToEl.addEventListener("input", () => {
  const v = parseInt(filterYearToEl.value, 10);
  collectionFilters.yearTo = Number.isFinite(v) ? v : null;
  drawCollection();
});
filtersClearEl.addEventListener("click", clearAllFilters);

exportCsvEl.addEventListener("click", () => {
  const filtered = applyFiltersAndSort(cardsCache);
  if (filtered.length === 0) {
    showToast("Nothing to export. Try clearing your filters.", { variant: "info" });
    return;
  }
  exportCSV(filtered);
});

// --- Public view-only share link (owner side) ------------------------------
// A "Share" panel in the collection view lets the owner mint a public, read-only
// link (createShareLink), copy it, or revoke it (revokeShareLink). The token is
// stored at users/{uid}.shareToken; getSharedCollection returns the cards with
// all dollar values / notes / locations stripped server-side.
const sharePanelEl = document.getElementById("share-panel");
const shareToggleEl = document.getElementById("share-btn");
let shareBusy = false; // guards against double-submits while a callable is running

if (shareToggleEl && sharePanelEl) {
  shareToggleEl.addEventListener("click", () => {
    const opening = sharePanelEl.hidden;
    sharePanelEl.hidden = !opening;
    shareToggleEl.classList.toggle("active", opening);
    shareToggleEl.setAttribute("aria-expanded", String(opening));
    if (opening) loadAndRenderSharePanel();
  });
}

// Build the public URL for a token. The app is hash-routed and Firebase Hosting
// rewrites every path to index.html, so origin + "/#/share/<token>" resolves.
function shareUrlFor(token) {
  return `${location.origin}/#/share/${token}`;
}

// Read the owner's current token (users/{uid}.shareToken) and paint the panel.
async function loadAndRenderSharePanel() {
  if (!sharePanelEl) return;
  if (IS_DEMO || !FIREBASE_READY || !currentUser) {
    renderSharePanel(null);
    return;
  }
  sharePanelEl.innerHTML = `<p class="muted">Loading…</p>`;
  let token = null;
  try {
    const snap = await getDoc(doc(db, "users", currentUser.uid));
    token = (snap.exists() && snap.data().shareToken) || null;
  } catch (err) {
    console.warn("Couldn't read share token", err);
  }
  renderSharePanel(token);
}

// Render the panel in either the "create" state (no token) or the "active" state
// (token present: URL + copy + turn-off).
function renderSharePanel(token) {
  if (!sharePanelEl) return;
  if (!token) {
    sharePanelEl.innerHTML = `
      <p class="share-explainer">Create a view-only link anyone can open — it shows your cards and details but <strong>NOT your dollar values</strong>. You can turn it off anytime.</p>
      <button type="button" id="share-create-btn" class="big-button primary">Create link</button>
    `;
    const createBtn = document.getElementById("share-create-btn");
    if (createBtn) createBtn.addEventListener("click", createShare);
    return;
  }
  const url = shareUrlFor(token);
  sharePanelEl.innerHTML = `
    <p class="share-explainer">Your collection is shared with a <strong>view-only</strong> link. Anyone with it can see your cards and details — but not your dollar values, notes, or locations.</p>
    <label class="share-url-label" for="share-url">Share link</label>
    <input id="share-url" class="share-url" type="text" readonly value="${esc(url)}" aria-label="Share link" />
    <div class="row">
      <button type="button" id="share-copy-btn" class="copy-btn" data-copy-target="#share-url">Copy link</button>
      <button type="button" id="share-revoke-btn" class="big-button danger">Turn off link</button>
    </div>
  `;
  // Select-all on focus so a tap makes the link easy to copy manually too.
  const urlInput = document.getElementById("share-url");
  if (urlInput) urlInput.addEventListener("focus", () => urlInput.select());
  const revokeBtn = document.getElementById("share-revoke-btn");
  if (revokeBtn) revokeBtn.addEventListener("click", revokeShare);
}

async function createShare() {
  if (shareBusy) return;
  if (IS_DEMO || !FIREBASE_READY || !currentUser) {
    showToast("Sign in to create a share link.", { variant: "error" });
    return;
  }
  const btn = document.getElementById("share-create-btn");
  shareBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }
  try {
    const callable = httpsCallable(functions, "createShareLink");
    const res = await callable();
    const token = res.data && res.data.token;
    if (!token) throw new Error("No token returned");
    renderSharePanel(token);
    showToast("Share link created.", { variant: "success" });
  } catch (err) {
    console.error("createShareLink failed", err);
    showToast("Couldn't create a share link. Try again.", { variant: "error" });
    if (btn) { btn.disabled = false; btn.textContent = "Create link"; }
  } finally {
    shareBusy = false;
  }
}

async function revokeShare() {
  if (shareBusy) return;
  if (IS_DEMO || !FIREBASE_READY || !currentUser) {
    showToast("Sign in to manage your share link.", { variant: "error" });
    return;
  }
  const ok = await confirmDialog({
    title: "Turn off the share link?",
    message: "Anyone you've sent it to will no longer be able to open it. You can create a new link later.",
    confirmLabel: "Turn off link",
    cancelLabel: "Keep it on",
    danger: true,
  });
  if (!ok) return;
  const btn = document.getElementById("share-revoke-btn");
  shareBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = "Turning off…"; }
  try {
    const callable = httpsCallable(functions, "revokeShareLink");
    await callable();
    renderSharePanel(null);
    showToast("Share link turned off.", { variant: "success" });
  } catch (err) {
    console.error("revokeShareLink failed", err);
    showToast("Couldn't turn off the link. Try again.", { variant: "error" });
    if (btn) { btn.disabled = false; btn.textContent = "Turn off link"; }
  } finally {
    shareBusy = false;
  }
}

// --- Public shared collection viewer (recipient side) ----------------------
// Read-only gallery rendered for #/share/{token}. getSharedCollection is PUBLIC
// (no auth), so it's called regardless of the visitor's anonymous sign-in. No
// prices, notes, locations, edit/delete, or links into the owner's app.
const shareViewContentEl = document.getElementById("share-view-content");

async function renderSharedView(token) {
  if (!shareViewContentEl) return;
  if (!FIREBASE_READY) {
    shareViewContentEl.innerHTML = `<div class="empty-state"><p>Shared collections aren't available here.</p></div>`;
    return;
  }
  if (!token) {
    shareViewContentEl.innerHTML = `<div class="empty-state"><p>This share link is no longer active.</p></div>`;
    return;
  }

  shareViewContentEl.innerHTML = `<p class="muted">Loading shared collection…</p>`;
  let data;
  try {
    const callable = httpsCallable(functions, "getSharedCollection");
    const res = await callable({ token });
    data = res.data || {};
  } catch (err) {
    console.warn("getSharedCollection failed", err);
    // "not-found" → revoked/invalid token. Anything else → generic, friendly.
    shareViewContentEl.innerHTML = `<div class="empty-state"><p>This share link is no longer active.</p></div>`;
    return;
  }

  const cards = Array.isArray(data.cards) ? data.cards : [];
  const count = typeof data.count === "number" ? data.count : cards.length;

  if (cards.length === 0) {
    shareViewContentEl.innerHTML = `
      <div class="share-view-head">
        <h2 tabindex="-1">Shared collection <span class="share-view-tag">view only</span></h2>
      </div>
      <div class="empty-state"><p>This collection doesn't have any cards yet.</p></div>`;
    focusHeadingEl(shareViewContentEl.querySelector("h2"));
    return;
  }

  const tiles = cards.map(renderSharedTile).join("");
  shareViewContentEl.innerHTML = `
    <div class="share-view-head">
      <h2 tabindex="-1">Shared collection <span class="share-view-tag">view only</span></h2>
      <p class="muted">${count} card${count === 1 ? "" : "s"}</p>
    </div>
    <div class="share-grid">${tiles}</div>
  `;
  focusHeadingEl(shareViewContentEl.querySelector("h2"));
}

// One non-clickable read-only tile. Mirrors the .collection-card visual style
// but is a <div>, not a link into the owner's detail/review routes.
function renderSharedTile(card) {
  const c = card || {};
  const id = c.identified || {};
  const t = itemTypeOf(c);
  const name = displayName(c);

  // Meta line: year + set + (team for cards / itemLabel for sealed product).
  const metaParts = [];
  if (id.year) metaParts.push(String(id.year));
  if (id.set) metaParts.push(id.set);
  if (t === "card") {
    if (id.team) metaParts.push(id.team);
  } else if (id.itemLabel) {
    metaParts.push(id.itemLabel);
  }
  const meta = metaParts.filter(Boolean).join(" • ");

  const badges = [];
  if (t === "card") {
    if (id.isRookie) badges.push(`<span class="badge rookie">Rookie</span>`);
    if (id.isHOF) badges.push(`<span class="badge hof">Hall of Fame</span>`);
  } else if (id.sealed) {
    badges.push(`<span class="badge sealed">Sealed</span>`);
  }

  return `
    <div class="share-card">
      <img src="${esc(c.imageFrontUrl || "")}" alt="${esc(name)}" loading="lazy" />
      <div class="info">
        <div class="name">${esc(name)}</div>
        ${meta ? `<div class="sub">${esc(meta)}</div>` : ""}
        ${badges.length ? `<div class="share-card-badges">${badges.join("")}</div>` : ""}
      </div>
    </div>
  `;
}

// --- CSV export ------------------------------------------------------------
function exportCSV(cards) {
  const headers = ["Type", "Name / Player", "Year", "Set", "Card #", "Sport", "Rookie", "HOF", "Sealed", "Configuration", "Value Low", "Value High", "Location", "Notes", "Date Added"];
  const rows = cards.map((c) => {
    const t = itemTypeOf(c);
    const sealed = t === "card" ? "" : c.identified?.sealed ? "Yes" : "";
    return [
      t,
      displayName(c),
      c.identified?.year || "",
      c.identified?.set || "",
      t === "card" ? c.identified?.cardNumber || "" : "",
      c.identified?.sport || "",
      c.identified?.isRookie ? "Yes" : "",
      c.identified?.isHOF ? "Yes" : "",
      sealed,
      t === "card" ? "" : c.identified?.configuration || "",
      c.valueEstimate?.low || "",
      c.valueEstimate?.high || "",
      locationName(c.locationId),
      (c.userNotes || "").replace(/\r?\n/g, " "),
      formatDate(c.createdAt),
    ];
  });
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `card-vault-${new Date().toISOString().split("T")[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tsMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  if (typeof ts === "number") return ts;
  return 0;
}

function formatDate(ts) {
  const ms = tsMs(ts);
  if (!ms) return "";
  return new Date(ms).toISOString().split("T")[0];
}

// --- Detail view -----------------------------------------------------------
async function renderDetail(cardId) {
  const el = document.getElementById("detail-content");

  if (IS_DEMO) {
    const sample = (cardsCache.length ? cardsCache : SAMPLE_CARDS).find((c) => c.id === cardId);
    if (!sample) {
      el.innerHTML = `<p class="muted">Card not found.</p>`;
      return;
    }
    detailState.cardId = cardId;
    detailState.card = sample;
    detailState.editing = false;
    renderDetailDisplay(el);
    return;
  }

  if (!currentUser) {
    el.innerHTML = `<p class="muted">Signing in...</p>`;
    return;
  }

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

  await loadLocations();

  if (detailState.editing) {
    renderDetailEditing(el);
  } else {
    renderDetailDisplay(el);
  }
}

function renderDetailDisplay(el) {
  const c = detailState.card;
  const highValue = (c.valueEstimate?.high || 0) >= HIGH_VALUE_THRESHOLD;
  const uncertain = (c.identified?.confidence || 0) < 0.5 && !c.identified?.userEdited;

  el.innerHTML = `
    ${IS_DEMO ? `<div class="demo-banner">This is a <strong>sample item</strong>. Editing and deleting are disabled in demo mode.</div>` : ""}
    ${highValue ? `<div class="high-value-banner">This could be worth a closer look — see the Guide before you sell, clean, or grade it.</div>` : ""}
    ${uncertain ? `<div class="uncertain-banner">The AI wasn't very sure about this one. Tap <strong>Edit details</strong> to correct anything.</div>` : ""}
    <div class="result-card">
      ${identifiedSummaryHTML(c)}
      <div class="value-block">
        <div class="label muted">Claude AI ballpark</div>
        <div class="range">$${fmt(c.valueEstimate?.low || 0)} &ndash; $${fmt(c.valueEstimate?.high || 0)}</div>
        <div class="note">${esc(c.valueEstimate?.note || "")}</div>
      </div>
      ${renderEbayBlock(c.ebayPrices)}
      ${renderPriceLinks(c)}
    </div>
    ${c.locationId && locationName(c.locationId) ? `<div class="location-display"><span aria-hidden="true">📍</span> <strong>Location:</strong> ${esc(locationName(c.locationId))}</div>` : ""}
    ${c.userNotes ? `<div class="notes-display">${esc(c.userNotes)}</div>` : ""}
    ${ebaySectionHTML(c)}
    ${IS_DEMO ? "" : `<div class="row"><button id="detail-edit-btn" class="big-button">Edit details &amp; notes</button></div>`}
    ${c.imageFrontUrl ? `<img src="${esc(c.imageFrontUrl)}" alt="Front" />` : ""}
    ${c.imageBackUrl ? `<img src="${esc(c.imageBackUrl)}" alt="Back" />` : ""}
    ${IS_DEMO ? "" : `<button id="delete-btn" class="big-button" style="color:var(--danger);">Remove from collection</button>`}
  `;

  if (!IS_DEMO) {
    document.getElementById("detail-edit-btn").addEventListener("click", () => {
      detailState.editing = true;
      renderDetail(detailState.cardId);
    });
    document.getElementById("delete-btn").addEventListener("click", async () => {
      if (!(await confirmDialog({ title: "Remove this card?", message: "This removes it from your collection.", confirmLabel: "Remove", cancelLabel: "Keep it", danger: true }))) return;
      try {
        await deleteDoc(doc(db, "users", currentUser.uid, "cards", detailState.cardId));
        detailState.cardId = null;
        detailState.card = null;
        detailState.editing = false;
        location.hash = "#/collection";
      } catch (err) {
        console.error(err);
        showToast("Couldn't remove. Try again.", { variant: "error" });
      }
    });
  }

  // a11y: the detail view has no static <h2>, so focus the rendered headline.
  focusHeadingEl(el.querySelector(".player"));
}

function renderDetailEditing(el) {
  const c = detailState.card;
  const locationOptions = [
    `<option value="">— No location —</option>`,
    ...locationsCache.map(
      (l) => `<option value="${esc(l.id)}" ${c.locationId === l.id ? "selected" : ""}>${esc(l.name)}</option>`,
    ),
  ].join("");

  const type = itemTypeOf(c);
  el.innerHTML =
    renderEditFormHTML(c.identified || {}, type) +
    `<div class="notes-section">
       <label for="detail-location">Location <span class="muted">(where it's stored)</span></label>
       <div class="location-pick">
         <select id="detail-location" class="control-select">${locationOptions}</select>
         <button type="button" id="detail-new-location" class="control-btn">+ New</button>
       </div>
       <a class="link-button" href="#/locations">Manage locations</a>
     </div>
     <div class="notes-section">
       <label for="detail-notes">Your notes</label>
       <textarea id="detail-notes" placeholder="e.g. From Grandpa's collection">${esc(c.userNotes || "")}</textarea>
     </div>
     <div class="row">
       <button id="detail-apply-btn" class="big-button primary">Save changes</button>
       <button id="detail-cancel-btn" class="big-button">Cancel</button>
     </div>`;

  // Inline location creation — make a new storage location and assign it without
  // leaving the page or losing the other edits in this form.
  document.getElementById("detail-new-location").addEventListener("click", async () => {
    if (IS_DEMO || !currentUser) {
      showToast("Sign in to add locations.", { variant: "error" });
      return;
    }
    const raw = await promptDialog({ title: "New location", label: 'Location name (e.g. "Binder A — Page 3")', placeholder: "Binder A — Page 3", confirmLabel: "Add" });
    if (raw == null) return;
    const name = raw.trim();
    if (!name) return;
    try {
      const id = crypto.randomUUID();
      await setDoc(doc(db, "users", currentUser.uid, "locations", id), {
        name,
        createdAt: serverTimestamp(),
      });
      locationsCache.push({ id, name });
      const sel = document.getElementById("detail-location");
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      sel.appendChild(opt);
      sel.value = id;
    } catch (err) {
      console.error(err);
      showToast("Couldn't add that location. Try again.", { variant: "error" });
    }
  });

  document.getElementById("detail-apply-btn").addEventListener("click", async () => {
    const applyBtn = document.getElementById("detail-apply-btn");
    applyBtn.disabled = true;
    applyBtn.textContent = "Saving...";
    const updatedIdentified = { ...c.identified, ...readEditFormValues(type), userEdited: true };
    const updatedNotes = document.getElementById("detail-notes").value;
    const updatedLocationId = document.getElementById("detail-location").value || null;
    try {
      await updateDoc(doc(db, "users", currentUser.uid, "cards", detailState.cardId), {
        identified: updatedIdentified,
        userNotes: updatedNotes || null,
        locationId: updatedLocationId,
      });
      detailState.card = { ...c, identified: updatedIdentified, userNotes: updatedNotes || null, locationId: updatedLocationId };
      detailState.editing = false;
      renderDetail(detailState.cardId);
    } catch (err) {
      console.error(err);
      showToast("Couldn't save changes. Try again.", { variant: "error" });
      applyBtn.disabled = false;
      applyBtn.textContent = "Save changes";
    }
  });
  document.getElementById("detail-cancel-btn").addEventListener("click", () => {
    detailState.editing = false;
    renderDetail(detailState.cardId);
  });

  // a11y: focus the edit form's heading after it renders.
  focusHeadingEl(el.querySelector(".edit-title"));
}

document.getElementById("back-btn").addEventListener("click", () => {
  // history.back() dead-ends on a deep-linked entry (no prior in-app history);
  // fall back to the collection in that case.
  if (history.length > 1) history.back();
  else location.hash = "#/collection";
});

// --- Locations -------------------------------------------------------------
const locationsListEl = document.getElementById("locations-list");
const locationsEmptyEl = document.getElementById("locations-empty");
const locationAddForm = document.getElementById("location-add-form");
const locationAddInput = document.getElementById("location-add-input");
// filterLocationEl is declared up with the other filter refs (see Collection view).

async function loadLocations() {
  if (IS_DEMO || !currentUser) {
    locationsCache = [];
    return;
  }
  const snap = await getDocs(
    query(collection(db, "users", currentUser.uid, "locations"), orderBy("name")),
  );
  locationsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function locationName(id) {
  if (!id) return "";
  const loc = locationsCache.find((l) => l.id === id);
  return loc ? loc.name : "";
}

async function renderLocations() {
  if (IS_DEMO || !currentUser) {
    locationsListEl.innerHTML = "";
    locationsEmptyEl.innerHTML = `<p>Sign in to create and manage locations.</p>`;
    locationsEmptyEl.hidden = false;
    return;
  }

  locationsListEl.innerHTML = `<p class="muted">Loading…</p>`;
  await loadLocations();

  // Count how many cards sit in each location so the list doubles as a map.
  // Reuse the already-loaded collection cache when available; only hit Firestore
  // when we have nothing cached (avoids a redundant full read of every card).
  const counts = {};
  if (cardsCache.length > 0) {
    cardsCache.forEach((c) => {
      const lid = c.locationId;
      if (lid) counts[lid] = (counts[lid] || 0) + 1;
    });
  } else {
    try {
      const snap = await getDocs(collection(db, "users", currentUser.uid, "cards"));
      snap.docs.forEach((d) => {
        const lid = d.data().locationId;
        if (lid) counts[lid] = (counts[lid] || 0) + 1;
      });
    } catch (err) {
      console.warn("Couldn't count cards per location", err);
    }
  }

  if (locationsCache.length === 0) {
    locationsListEl.innerHTML = "";
    locationsEmptyEl.innerHTML = `<p>No locations yet. Add one above &mdash; like &ldquo;Binder A&rdquo; or &ldquo;Shoebox in the closet.&rdquo;</p>`;
    locationsEmptyEl.hidden = false;
    return;
  }

  locationsEmptyEl.hidden = true;
  locationsListEl.innerHTML = locationsCache
    .map((l) => {
      const n = counts[l.id] || 0;
      return `
        <div class="location-row" data-id="${esc(l.id)}">
          <div class="location-main">
            <span class="location-name">${esc(l.name)}</span>
            <span class="location-count">${n} card${n === 1 ? "" : "s"}</span>
          </div>
          <div class="location-actions">
            <button type="button" class="link-button" data-act="rename">Rename</button>
            <button type="button" class="link-button danger" data-act="delete">Delete</button>
          </div>
        </div>`;
    })
    .join("");
}

if (locationAddForm) {
  locationAddForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = locationAddInput.value.trim();
    if (!name) return;
    if (IS_DEMO || !currentUser) {
      showToast("Sign in to add locations.", { variant: "error" });
      return;
    }
    try {
      const id = crypto.randomUUID();
      await setDoc(doc(db, "users", currentUser.uid, "locations", id), {
        name,
        createdAt: serverTimestamp(),
      });
      locationAddInput.value = "";
      await renderLocations();
    } catch (err) {
      console.error(err);
      showToast("Couldn't add that location. Try again.", { variant: "error" });
    }
  });
}

if (locationsListEl) {
  locationsListEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const row = btn.closest(".location-row");
    const id = row && row.dataset.id;
    if (!id) return;
    const loc = locationsCache.find((l) => l.id === id);

    if (btn.dataset.act === "rename") {
      const next = await promptDialog({ title: "Rename location", label: "Location name", value: loc ? loc.name : "", confirmLabel: "Save" });
      if (next == null) return;
      const name = next.trim();
      if (!name) return;
      try {
        await updateDoc(doc(db, "users", currentUser.uid, "locations", id), { name });
        await renderLocations();
      } catch (err) {
        console.error(err);
        showToast("Couldn't rename. Try again.", { variant: "error" });
      }
    } else if (btn.dataset.act === "delete") {
      const label = loc ? loc.name : "this location";
      if (!(await confirmDialog({ title: `Delete "${label}"?`, message: "Cards assigned to it will become unassigned.", confirmLabel: "Delete", cancelLabel: "Cancel", danger: true }))) return;
      try {
        await deleteDoc(doc(db, "users", currentUser.uid, "locations", id));
        await renderLocations();
      } catch (err) {
        console.error(err);
        showToast("Couldn't delete. Try again.", { variant: "error" });
      }
    }
  });
}

// Keep the collection's Location filter <select> in sync with the cache.
function populateLocationFilter() {
  if (!filterLocationEl) return;
  const current = collectionFilters.location;
  const opts = [
    `<option value="all">All locations</option>`,
    `<option value="none">Unassigned</option>`,
    ...locationsCache.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`),
  ];
  filterLocationEl.innerHTML = opts.join("");
  // Preserve the active selection if it still exists; otherwise fall back.
  const stillValid =
    current === "all" ||
    current === "none" ||
    locationsCache.some((l) => l.id === current);
  collectionFilters.location = stillValid ? current : "all";
  filterLocationEl.value = collectionFilters.location;
}

// --- Review view (pending pool) --------------------------------------------
// Scanned cards are persisted as status:"pending" the moment they're identified
// (see persistPendingCard). The review flow lets the user Keep or Discard each;
// the collection only ever shows kept cards.
const reviewContentEl = document.getElementById("review-content");

// Fetch all pending cards, newest first. Uses a single-field equality query (no
// orderBy) so it needs NO composite index; we sort newest-first client-side.
async function fetchPendingCards() {
  const snap = await getDocs(
    query(
      collection(db, "users", currentUser.uid, "cards"),
      where("status", "==", "pending"),
    ),
  );
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt));
}

// Find the next pending card to review after acting on `excludeId`.
async function nextPendingId(excludeId) {
  try {
    const pend = await fetchPendingCards();
    const next = pend.find((c) => c.id !== excludeId);
    return next ? next.id : null;
  } catch (err) {
    console.warn("Couldn't look up next pending card", err);
    return null;
  }
}

async function renderReview() {
  if (!reviewContentEl) return;
  reviewState.cardId = null;
  reviewState.card = null;
  reviewState.editing = false;

  if (IS_DEMO || !FIREBASE_READY) {
    reviewContentEl.innerHTML = `<div class="empty-state"><p>Scanned cards land here for review once you're signed in. (Demo mode shows the sample collection directly.)</p></div>`;
    return;
  }
  if (!currentUser) {
    reviewContentEl.innerHTML = `<p class="muted">Signing in…</p>`;
    return;
  }

  reviewContentEl.innerHTML = `<p class="muted">Loading…</p>`;
  let pend;
  try {
    pend = await fetchPendingCards();
  } catch (err) {
    console.error("Couldn't load pending cards", err);
    reviewContentEl.innerHTML = `<div class="empty-state"><p>Couldn't load cards to review. Try again.</p></div>`;
    return;
  }

  pendingCount = pend.length;
  updateNavBadge();
  updateReviewSurfaces();

  if (pend.length === 0) {
    reviewContentEl.innerHTML = `
      <div class="empty-state">
        <p>Nothing to review right now. Scanned cards land here until you Keep or Discard them.</p>
        <a href="#/scan" class="big-button primary cta">Scan a card</a>
      </div>`;
    return;
  }

  const items = pend
    .map(
      (c) => `
        <a class="review-row" href="#/review/${esc(c.id)}">
          <img src="${esc(c.imageFrontUrl || "")}" alt="" />
          <div class="review-row-main">
            <div class="review-row-name">${esc(displayName(c))}</div>
            <div class="review-row-sub">${reviewRowMeta(c)}</div>
          </div>
          <span class="review-row-go" aria-hidden="true">&rarr;</span>
        </a>`,
    )
    .join("");

  reviewContentEl.innerHTML = `
    <p class="review-count">${pend.length} card${pend.length === 1 ? "" : "s"} to review</p>
    <div class="review-list">${items}</div>
  `;
}

// Short meta line for a pending card in the review list.
function reviewRowMeta(c) {
  const id = c.identified || {};
  const t = itemTypeOf(c);
  const parts = [];
  if (id.year) parts.push(String(id.year));
  if (id.set) parts.push(id.set);
  if (t === "card") {
    if (id.cardNumber) parts.push(`#${id.cardNumber}`);
  } else {
    parts.push(t === "pack" ? "Sealed pack" : "Sealed box");
  }
  return esc(parts.filter(Boolean).join(" • "));
}

async function renderReviewCard(cardId) {
  if (!reviewContentEl) return;
  if (IS_DEMO || !FIREBASE_READY) {
    location.hash = "#/review";
    return;
  }
  if (!currentUser) {
    reviewContentEl.innerHTML = `<p class="muted">Signing in…</p>`;
    return;
  }

  // Load fresh unless we're re-rendering the same card (e.g. toggling edit).
  if (reviewState.cardId !== cardId || !reviewState.card) {
    reviewContentEl.innerHTML = `<p class="muted">Loading…</p>`;
    let snap;
    try {
      snap = await getDoc(doc(db, "users", currentUser.uid, "cards", cardId));
    } catch (err) {
      console.error("Couldn't load card to review", err);
      location.hash = "#/review";
      return;
    }
    if (!snap.exists() || snap.data().status !== "pending") {
      // Already kept/discarded elsewhere, or gone — back to the list.
      location.hash = "#/review";
      return;
    }
    reviewState.cardId = cardId;
    reviewState.card = { id: cardId, ...snap.data() };
    reviewState.editing = false;
  }

  await loadLocations();

  if (reviewState.editing) {
    renderReviewEditing();
  } else {
    renderReviewDisplay();
  }
}

function renderReviewDisplay() {
  const c = reviewState.card;
  const highValue = (c.valueEstimate?.high || 0) >= HIGH_VALUE_THRESHOLD;
  const uncertain = (c.identified?.confidence || 0) < 0.5 && !c.identified?.userEdited;

  reviewContentEl.innerHTML = `
    <a class="link-button" href="#/review">&larr; All cards to review</a>
    <div class="review-banner">Reviewing a scanned card. <strong>Keep</strong> it to add it to your collection, or <strong>Discard</strong> it. It's saved safely until you decide.</div>
    ${highValue ? `<div class="high-value-banner">This could be worth a closer look — see the Guide before you sell, clean, or grade it.</div>` : ""}
    ${uncertain ? `<div class="uncertain-banner">The AI wasn't very sure about this one. Tap <strong>Edit details</strong> to correct anything.</div>` : ""}
    <div class="result-card">
      ${identifiedSummaryHTML(c)}
      <div class="value-block">
        <div class="label muted">Claude AI ballpark</div>
        <div class="range">$${fmt(c.valueEstimate?.low || 0)} &ndash; $${fmt(c.valueEstimate?.high || 0)}</div>
        <div class="note">${esc(c.valueEstimate?.note || "")}</div>
      </div>
      ${renderEbayBlock(c.ebayPrices)}
      ${renderPriceLinks(c)}
      <button id="review-edit-btn" class="link-button" style="margin-top: 10px;">Edit details</button>
    </div>
    ${c.locationId && locationName(c.locationId) ? `<div class="location-display"><span aria-hidden="true">📍</span> <strong>Location:</strong> ${esc(locationName(c.locationId))}</div>` : ""}
    ${c.imageFrontUrl ? `<img src="${esc(c.imageFrontUrl)}" alt="Front" />` : ""}
    ${c.imageBackUrl ? `<img src="${esc(c.imageBackUrl)}" alt="Back" />` : ""}
    <div class="row">
      <button id="review-keep-btn" class="big-button primary">Keep in collection</button>
      <button id="review-discard-btn" class="big-button">Discard</button>
    </div>
  `;

  document.getElementById("review-edit-btn").addEventListener("click", () => {
    reviewState.editing = true;
    renderReviewCard(reviewState.cardId);
  });
  document.getElementById("review-keep-btn").addEventListener("click", keepReviewedCard);
  document.getElementById("review-discard-btn").addEventListener("click", discardReviewedCard);

  focusHeadingEl(reviewContentEl.querySelector(".player"));
}

function renderReviewEditing() {
  const c = reviewState.card;
  const type = itemTypeOf(c);
  const locationOptions = [
    `<option value="">— No location —</option>`,
    ...locationsCache.map(
      (l) => `<option value="${esc(l.id)}" ${c.locationId === l.id ? "selected" : ""}>${esc(l.name)}</option>`,
    ),
  ].join("");

  reviewContentEl.innerHTML =
    renderEditFormHTML(c.identified || {}, type) +
    `<div class="notes-section">
       <label for="review-location">Location <span class="muted">(where it's stored)</span></label>
       <div class="location-pick">
         <select id="review-location" class="control-select">${locationOptions}</select>
         <button type="button" id="review-new-location" class="control-btn">+ New</button>
       </div>
     </div>
     <div class="notes-section">
       <label for="review-notes">Your notes</label>
       <textarea id="review-notes" placeholder="e.g. From Grandpa's collection">${esc(c.userNotes || "")}</textarea>
     </div>
     <div class="row">
       <button id="review-apply-btn" class="big-button primary">Done editing</button>
       <button id="review-cancel-btn" class="big-button">Cancel</button>
     </div>`;

  document.getElementById("review-new-location").addEventListener("click", async () => {
    const raw = await promptDialog({ title: "New location", label: 'Location name (e.g. "Binder A — Page 3")', placeholder: "Binder A — Page 3", confirmLabel: "Add" });
    if (raw == null) return;
    const name = raw.trim();
    if (!name) return;
    try {
      const id = crypto.randomUUID();
      await setDoc(doc(db, "users", currentUser.uid, "locations", id), {
        name,
        createdAt: serverTimestamp(),
      });
      locationsCache.push({ id, name });
      const sel = document.getElementById("review-location");
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      sel.appendChild(opt);
      sel.value = id;
    } catch (err) {
      console.error(err);
      showToast("Couldn't add that location. Try again.", { variant: "error" });
    }
  });

  // "Done editing" folds the edits back into reviewState.card (kept in memory)
  // without writing yet — the write happens on Keep, so a Discard doesn't persist
  // pointless edits.
  document.getElementById("review-apply-btn").addEventListener("click", () => {
    reviewState.card = {
      ...c,
      identified: { ...c.identified, ...readEditFormValues(type), userEdited: true },
      userNotes: document.getElementById("review-notes").value || null,
      locationId: document.getElementById("review-location").value || null,
    };
    reviewState.editing = false;
    renderReviewCard(reviewState.cardId);
  });
  document.getElementById("review-cancel-btn").addEventListener("click", () => {
    reviewState.editing = false;
    renderReviewCard(reviewState.cardId);
  });

  focusHeadingEl(reviewContentEl.querySelector(".edit-title"));
}

async function keepReviewedCard() {
  const c = reviewState.card;
  if (!c) return;
  const keepBtn = document.getElementById("review-keep-btn");
  if (keepBtn) { keepBtn.disabled = true; keepBtn.textContent = "Saving…"; }
  try {
    await updateDoc(doc(db, "users", currentUser.uid, "cards", c.id), {
      status: "kept",
      identified: c.identified || {},
      userNotes: c.userNotes || null,
      locationId: c.locationId || null,
    });
  } catch (err) {
    console.error("Couldn't keep card", err);
    showToast("Couldn't save that. Try again.", { variant: "error" });
    if (keepBtn) { keepBtn.disabled = false; keepBtn.textContent = "Keep in collection"; }
    return;
  }
  showToast("Kept in your collection.", { variant: "success" });
  await advanceAfterReview(c.id, "#/collection");
}

async function discardReviewedCard() {
  const c = reviewState.card;
  if (!c) return;
  const ok = await confirmDialog({
    title: "Discard this card?",
    message: "It won't be added to your collection and its photos will be removed.",
    confirmLabel: "Discard",
    cancelLabel: "Keep reviewing",
    danger: true,
  });
  if (!ok) return;
  try {
    // The deployed onCardDeleted trigger removes the card's Storage images.
    await deleteDoc(doc(db, "users", currentUser.uid, "cards", c.id));
  } catch (err) {
    console.error("Couldn't discard card", err);
    showToast("Couldn't discard that. Try again.", { variant: "error" });
    return;
  }
  await advanceAfterReview(c.id, "#/review");
}

// After Keep/Discard: clear review state, refresh the pending count, then move
// to the next pending card if there is one, else the given fallback route.
async function advanceAfterReview(actedId, fallbackHash) {
  reviewState.cardId = null;
  reviewState.card = null;
  reviewState.editing = false;
  const nextId = await nextPendingId(actedId);
  await refreshPendingCount();
  if (nextId) {
    location.hash = `#/review/${nextId}`;
    // If the hash didn't change (shouldn't happen for distinct ids), force a render.
  } else {
    location.hash = fallbackHash;
  }
}

// --- In-app dialogs (replaces native alert/confirm/prompt) -----------------
// Native dialogs are jarring on phones, can't be styled to match the app, and
// some mobile browsers suppress them. These accessible equivalents build their
// own DOM (appended to <body>), so no extra HTML is needed in index.html.

// Non-blocking toast. opts.variant: "error" | "info" | "success" (default info).
function showToast(message, opts = {}) {
  const variant = opts.variant || "info";
  let container = document.getElementById("cv-toasts");
  if (!container) {
    container = document.createElement("div");
    container.id = "cv-toasts";
    container.className = "cv-toasts";
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "polite");
    container.setAttribute("aria-atomic", "true");
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `cv-toast cv-toast-${variant}`;
  toast.textContent = String(message ?? "");

  let removed = false;
  let timer = null;
  function dismiss() {
    if (removed) return;
    removed = true;
    if (timer) clearTimeout(timer);
    toast.classList.add("cv-toast-leaving");
    // Remove after the short fade-out (neutralized under prefers-reduced-motion).
    setTimeout(() => toast.remove(), 200);
  }
  toast.addEventListener("click", dismiss);
  container.appendChild(toast);
  // Trigger the enter transition on the next frame.
  requestAnimationFrame(() => toast.classList.add("cv-toast-in"));
  timer = setTimeout(dismiss, 4000);
  return toast;
}

// Shared modal scaffolding for confirmDialog / promptDialog. Returns the pieces
// each needs and centralizes focus trapping, Escape/backdrop dismissal, and
// focus restore. `buildBody(dialog)` adds the dialog's inner content and must
// return the element to focus first. `onClose(result)` resolves the promise.
function openModal({ labelledBy, describedBy, buildBody, getFocusables, onClose }) {
  const previouslyFocused = document.activeElement;
  const backdrop = document.createElement("div");
  backdrop.className = "cv-modal-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "cv-modal";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  if (labelledBy) dialog.setAttribute("aria-labelledby", labelledBy);
  if (describedBy) dialog.setAttribute("aria-describedby", describedBy);
  backdrop.appendChild(dialog);

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown, true);
    backdrop.remove();
    // Restore focus to wherever the user was before the dialog opened.
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      try { previouslyFocused.focus(); } catch (_) { /* element may be gone */ }
    }
    onClose(result);
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close(undefined); // caller maps undefined → cancel value
      return;
    }
    if (e.key === "Tab") {
      const focusables = getFocusables(dialog).filter((el) => el && !el.disabled);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  backdrop.addEventListener("mousedown", (e) => {
    // Backdrop click cancels — only when the click started on the backdrop
    // itself (not on the dialog, which would catch text-selection drags).
    if (e.target === backdrop) close(undefined);
  });

  const focusTarget = buildBody(dialog, close);
  document.body.appendChild(backdrop);
  document.addEventListener("keydown", onKeydown, true);
  // Move focus into the dialog after it's in the DOM.
  if (focusTarget && typeof focusTarget.focus === "function") {
    try { focusTarget.focus(); } catch (_) { /* noop */ }
  }
  return close;
}

// Promise<boolean>. Resolves true on confirm; false on cancel/backdrop/Escape.
function confirmDialog(opts = {}) {
  const {
    title = "",
    message = "",
    confirmLabel = "OK",
    cancelLabel = "Cancel",
    danger = false,
  } = opts;
  return new Promise((resolve) => {
    const titleId = "cv-modal-title";
    const msgId = "cv-modal-desc";
    openModal({
      labelledBy: title ? titleId : null,
      describedBy: message ? msgId : null,
      getFocusables: (dialog) => Array.from(dialog.querySelectorAll("button")),
      onClose: (result) => resolve(result === true),
      buildBody: (dialog, close) => {
        dialog.innerHTML = `
          ${title ? `<h2 class="cv-modal-title" id="${titleId}">${esc(title)}</h2>` : ""}
          ${message ? `<p class="cv-modal-message" id="${msgId}">${esc(message)}</p>` : ""}
          <div class="cv-modal-actions">
            <button type="button" class="big-button cv-modal-cancel">${esc(cancelLabel)}</button>
            <button type="button" class="big-button primary cv-modal-confirm${danger ? " danger" : ""}">${esc(confirmLabel)}</button>
          </div>
        `;
        dialog.querySelector(".cv-modal-cancel").addEventListener("click", () => close(false));
        dialog.querySelector(".cv-modal-confirm").addEventListener("click", () => close(true));
        return dialog.querySelector(".cv-modal-confirm");
      },
    });
  });
}

// Promise<string|null>. Resolves the raw input value on Save (callers .trim()
// as needed); null on cancel/backdrop/Escape.
function promptDialog(opts = {}) {
  const {
    title = "",
    label = "",
    value = "",
    placeholder = "",
    confirmLabel = "Save",
  } = opts;
  return new Promise((resolve) => {
    const titleId = "cv-modal-title";
    const labelId = "cv-modal-label";
    const inputId = "cv-modal-input";
    openModal({
      labelledBy: title ? titleId : null,
      describedBy: label ? labelId : null,
      getFocusables: (dialog) =>
        Array.from(dialog.querySelectorAll("input, button")),
      onClose: (result) => resolve(typeof result === "string" ? result : null),
      buildBody: (dialog, close) => {
        dialog.innerHTML = `
          ${title ? `<h2 class="cv-modal-title" id="${titleId}">${esc(title)}</h2>` : ""}
          <label class="cv-modal-field" for="${inputId}">
            ${label ? `<span id="${labelId}">${esc(label)}</span>` : ""}
            <input id="${inputId}" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" />
          </label>
          <div class="cv-modal-actions">
            <button type="button" class="big-button cv-modal-cancel">Cancel</button>
            <button type="button" class="big-button primary cv-modal-confirm">${esc(confirmLabel)}</button>
          </div>
        `;
        const input = dialog.querySelector("#" + inputId);
        dialog.querySelector(".cv-modal-cancel").addEventListener("click", () => close(null));
        dialog.querySelector(".cv-modal-confirm").addEventListener("click", () => close(input.value));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            close(input.value);
          }
        });
        return input;
      },
    });
  });
}

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

// Render the eBay sold-listings block. Returns "" if no data so the result
// view collapses cleanly when Claude couldn't find a match or eBay was blocked.
function renderEbayBlock(ebay) {
  if (!ebay || !ebay.count) return "";
  if (ebay.count === 0) return "";
  const median = ebay.median != null ? `$${fmt(ebay.median)}` : "—";
  const range = ebay.min != null && ebay.max != null ? `$${fmt(ebay.min)} – $${fmt(ebay.max)}` : "—";
  const link = ebay.searchUrl ? `<a href="${esc(ebay.searchUrl)}" target="_blank" rel="noopener">View on eBay &rarr;</a>` : "";
  return `
    <div class="value-block ebay-block">
      <div class="label muted">eBay sold (recent)</div>
      <div class="range">${median}</div>
      <div class="note">Median across ${ebay.count} recent sales. Range ${range}. Mixed conditions — may include graded cards.<br/>${link}</div>
    </div>
  `;
}

// Build a row of "Compare on" links to external pricing sources we can't
// scrape (anti-bot protection, paid APIs, etc.) — just send the user to a
// pre-filled search URL on each site. Returns "" if no card to look up.
function renderPriceLinks(data) {
  const identified = data?.identified || {};
  const t = itemTypeOf(data);
  let parts;
  if (t === "pack" || t === "box") {
    if (!identified.itemLabel || /^unknown/i.test(identified.itemLabel)) return "";
    parts = [identified.year, identified.set, identified.itemLabel, "sealed"];
  } else {
    if (!identified.player || identified.player === "Unknown card") return "";
    parts = [identified.year, identified.set, identified.player, identified.cardNumber];
  }
  const query = parts.filter(Boolean).join(" ");
  if (!query.trim()) return "";
  const q = encodeURIComponent(query);
  // Sites are independently URL-encoded; some accept + or %20 — both work.
  const sources = [
    { name: "eBay Sold", url: `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1` },
    { name: "SportsCardsPro", url: `https://www.sportscardspro.com/search-products?type=prices&q=${q}&go=Go` },
    { name: "PriceCharting", url: `https://www.pricecharting.com/search-products?type=prices&q=${q}&go=Go` },
    { name: "130point", url: `https://130point.com/cards/?q=${q}` },
    { name: "TCDB", url: `https://www.tcdb.com/Search.cfm?Search=${q}` },
  ];
  return `
    <div class="price-links">
      <div class="label muted">Compare prices on</div>
      <ul class="price-links-list">
        ${sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)} &rarr;</a></li>`).join("")}
      </ul>
    </div>
  `;
}

function escAttr(s) {
  return String(s ?? "").replace(/[^a-zA-Z0-9_-]/g, "-");
}

function capSport(s) {
  if (!s) return "";
  return s[0].toUpperCase() + s.slice(1);
}

// --- eBay listing generator ------------------------------------------------
function ebayTitle(c) {
  const id = c.identified || {};
  const t = itemTypeOf(c);
  const parts = [];
  if (id.year) parts.push(String(id.year));
  if (id.set) parts.push(id.set);
  if (t === "pack" || t === "box") {
    if (id.sport) parts.push(capSport(id.sport));
    if (id.itemLabel) parts.push(id.itemLabel);
    if (id.sealed) parts.push("SEALED UNOPENED");
  } else {
    if (id.player) parts.push(id.player);
    if (id.cardNumber) parts.push(`#${id.cardNumber}`);
    if (id.team) parts.push(id.team);
    if (id.sport) parts.push(capSport(id.sport));
    if (id.isRookie) parts.push("ROOKIE RC");
    if (id.isHOF) parts.push("HOF");
  }
  let title = parts.join(" ").trim();
  if (!title) title = t === "pack" ? "Sealed card pack" : t === "box" ? "Sealed card box" : "Sports card";
  if (title.length > 80) title = title.slice(0, 77).trimEnd() + "...";
  return title;
}

function ebayDescription(c) {
  const id = c.identified || {};
  const val = c.valueEstimate || {};
  const t = itemTypeOf(c);
  const lines = [];

  if (t === "pack" || t === "box") {
    const header = [id.year, id.set, id.itemLabel].filter(Boolean).join(" ");
    if (header) lines.push(header);
    const meta = [];
    if (id.sport) meta.push(capSport(id.sport));
    if (id.configuration) meta.push(id.configuration);
    if (meta.length) lines.push(meta.join(" • "));
    lines.push("");

    const highlights = [];
    if (id.sealed) highlights.push("Appears factory sealed / unopened");
    if (typeof id.year === "number") {
      if (id.year < 1980) highlights.push("Vintage sealed product");
      else if (id.year <= 1995) highlights.push("Vintage / junk-wax-era product");
    }
    if (id.notable) highlights.push(id.notable);
    if (highlights.length) {
      lines.push("Highlights:");
      for (const h of highlights) lines.push(`- ${h}`);
      lines.push("");
    }

    lines.push("CONDITION & AUTHENTICITY:");
    lines.push(
      "This sealed product has NOT been independently authenticated. Please review all photos carefully and judge the seal and condition for yourself before bidding. Sold as-is from a personal collection.",
    );
    lines.push("");
  } else {
    const header = [id.year, id.set, id.player].filter(Boolean).join(" ");
    if (header) lines.push(header);
    const meta = [];
    if (id.cardNumber) meta.push(`Card #${id.cardNumber}`);
    if (id.team) meta.push(id.team);
    if (id.sport) meta.push(capSport(id.sport));
    if (meta.length) lines.push(meta.join(" • "));
    lines.push("");

    const highlights = [];
    if (id.isRookie) highlights.push("Rookie card (RC)");
    if (id.isHOF) highlights.push("Hall of Fame player");
    if (typeof id.year === "number") {
      if (id.year < 1946) highlights.push("Pre-war vintage");
      else if (id.year <= 1980) highlights.push("Vintage");
    }
    if (highlights.length) {
      lines.push("Highlights:");
      for (const h of highlights) lines.push(`- ${h}`);
      lines.push("");
    }

    lines.push("CONDITION:");
    lines.push(
      "This card has NOT been professionally graded. Please review all photos carefully to assess condition before bidding. Sold as-is from a personal collection.",
    );
    lines.push("");
  }

  if (val.low || val.high) {
    lines.push(
      `Reference value range (rough estimate): $${fmt(val.low || 0)} - $${fmt(val.high || 0)}. Verify against recent eBay "Sold" listings before bidding.`,
    );
    lines.push("");
  }

  if (c.userNotes) {
    lines.push(`Seller notes: ${c.userNotes}`);
    lines.push("");
  }

  lines.push("Combined shipping available on multiple purchases. Message with any questions before bidding.");

  return lines.join("\n").trim();
}

function ebaySectionHTML(c) {
  const title = ebayTitle(c);
  const desc = ebayDescription(c);
  const slug = escAttr(c.id || "result");
  return `
    <details class="ebay-section">
      <summary>Generate eBay listing</summary>
      <div class="ebay-content">
        <div class="ebay-field">
          <div class="ebay-field-label">
            <span>Title</span>
            <span class="ebay-field-hint">${title.length}/80 chars</span>
          </div>
          <input type="text" id="ebay-title-${slug}" readonly value="${esc(title)}" />
          <button class="copy-btn" data-copy-target="#ebay-title-${slug}">Copy title</button>
        </div>
        <div class="ebay-field">
          <div class="ebay-field-label">
            <span>Description</span>
            <span class="ebay-field-hint">editable</span>
          </div>
          <textarea id="ebay-desc-${slug}">${esc(desc)}</textarea>
          <div class="ebay-ai-row">
            <button type="button" class="control-btn ai-listing-btn" data-ai-slug="${slug}" data-ai-target="#ebay-desc-${slug}"><span aria-hidden="true">✦</span> Write a better description with AI</button>
            <span class="ai-listing-status" id="ai-listing-status-${slug}" aria-live="polite"></span>
          </div>
          <p class="ebay-ai-hint muted">Researches the item online and writes a professional, sales-focused description. Edit it after.</p>
          <button class="copy-btn" data-copy-target="#ebay-desc-${slug}">Copy description</button>
        </div>
      </div>
    </details>
  `;
}

async function copyToClipboard(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Fallback for non-secure contexts
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {}
    document.body.removeChild(ta);
  }
  const original = btn.dataset.originalLabel || btn.textContent;
  btn.dataset.originalLabel = original;
  btn.textContent = ok ? "Copied!" : "Press Ctrl+C";
  btn.classList.toggle("copied", ok);
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("copied");
  }, 1500);
}

// Refresh just the eBay title on the result view when notes change. The
// description is now editable / AI-fillable, so we deliberately leave it alone
// rather than overwriting any edits the user (or the AI) made.
function refreshResultEbayContent() {
  if (!state.lastIdentified) return;
  const titleInput = document.querySelector('#result-card .ebay-section input[id^="ebay-title-"]');
  if (!titleInput) return;
  const cardData = { ...state.lastIdentified, userNotes: state.notes };
  titleInput.value = ebayTitle(cardData);
  const hint = titleInput.closest(".ebay-field")?.querySelector(".ebay-field-hint");
  if (hint) hint.textContent = `${titleInput.value.length}/80 chars`;
}

// Event delegation for all copy buttons (result view + detail view).
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  const target = document.querySelector(btn.dataset.copyTarget);
  if (!target) return;
  await copyToClipboard(target.value, btn);
});

// --- AI eBay description ----------------------------------------------------
async function generateListingDescription(data) {
  if (USE_MOCK_AI || !FIREBASE_READY || !currentUser) {
    await new Promise((r) => setTimeout(r, 700));
    return mockListing(data);
  }
  const callable = httpsCallable(functions, "generateListing");
  const res = await callable({
    itemType: itemTypeOf(data),
    identified: data.identified,
    valueEstimate: data.valueEstimate,
    userNotes: data.userNotes || null,
  });
  return res.data.description;
}

function mockListing(data) {
  const id = data.identified || {};
  const name = displayName(data);
  const header = [id.year, id.set].filter(Boolean).join(" ");
  return (
    `${name}${header ? ` — ${header}` : ""}\n\n` +
    `(Demo sample — the live app researches the item online and writes a real, professional description here.) ` +
    `A standout piece from a personal collection that collectors of this era actively seek out. ` +
    `Please review all photos closely and judge the condition for yourself — this item is raw/ungraded and sold as-is. ` +
    `Combined shipping is available. Message with any questions before bidding.`
  );
}

// Event delegation for the "Write with AI" buttons (result + detail views).
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".ai-listing-btn");
  if (!btn) return;
  const slug = btn.dataset.aiSlug;
  const target = document.querySelector(btn.dataset.aiTarget);
  if (!target) return;

  let data;
  if (slug === "result" && state.lastIdentified) {
    data = { ...state.lastIdentified, userNotes: state.notes };
  } else if (detailState.card) {
    data = detailState.card;
  } else {
    return;
  }

  const statusEl = document.getElementById(`ai-listing-status-${slug}`);
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Writing…";
  if (statusEl) statusEl.textContent = "Researching the item and writing…";
  try {
    target.value = await generateListingDescription(data);
    if (statusEl) statusEl.textContent = "Done — edit it however you like.";
  } catch (err) {
    console.error("generateListing failed", err);
    if (statusEl) statusEl.textContent = "Couldn't write one just now. Try again.";
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
    setTimeout(() => {
      if (statusEl) statusEl.textContent = "";
    }, 5000);
  }
});

// --- Boot ------------------------------------------------------------------
route();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      // Only auto-reload on update if a controller already existed at load time.
      // A first-ever install has no controller, so it must never trigger a reload.
      const hadController = !!navigator.serviceWorker.controller;
      const registration = await navigator.serviceWorker.register("sw.js");

      // It's only SAFE to hard-reload when there's no in-flight or unsaved work:
      // the scan QUEUE is empty, there's no pending identified result, and the
      // user isn't sitting on the result view. Otherwise a reload would wipe the
      // in-memory queue / unsaved capture.
      function reloadIsSafe() {
        return (
          QUEUE.jobs.length === 0 &&
          !state.lastIdentified &&
          !(location.hash || "").startsWith("#/result")
        );
      }

      function notifyUpdatePending() {
        // Non-blocking notice — let the user finish, then refresh on their terms.
        if (scanStatus) {
          scanStatus.textContent = "An update is ready — refresh when you're done.";
        }
      }

      // Guard against the double-reload that controllerchange can otherwise cause.
      let refreshing = false;
      if (hadController) {
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (refreshing) return;
          if (reloadIsSafe()) {
            refreshing = true;
            window.location.reload();
          } else {
            notifyUpdatePending();
          }
        });
      }

      // Poll every 60 seconds so a long-open tab eventually catches deploys.
      setInterval(() => registration.update().catch(() => {}), 60_000);
    } catch (err) {
      console.warn("Service worker registration failed:", err);
    }
  });
}
