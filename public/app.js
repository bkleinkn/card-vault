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
    if (location.hash === "#/collection") renderCollection();
  });

  signInAnonymously(auth).catch((err) => {
    console.error("Anonymous sign-in failed", err);
    document.getElementById("user-chip").textContent = "Offline";
  });
} else {
  document.getElementById("user-chip").textContent = "Demo mode";
}

const IS_DEMO = !FIREBASE_READY;

// --- State -----------------------------------------------------------------
const state = {
  frontFile: null,
  backFile: null,
  lastIdentified: null, // { identified, valueEstimate, itemType }
  notes: "",
  editingResult: false,
  reviewJobId: null,    // when set, the result view is reviewing a queued scan
  itemType: "card",     // what the scanner is currently set to: card | pack | box
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
  document.querySelectorAll(".view").forEach((v) => {
    v.hidden = v.dataset.view !== name;
  });
  document.querySelectorAll(".navlink").forEach((a) => {
    a.classList.toggle("active", a.dataset.nav === name);
  });
}

function route() {
  const hash = location.hash || "#/scan";
  const isScan = hash === "#" || hash === "" || hash.startsWith("#/scan");
  if (!isScan) stopScanCamera();

  if (hash.startsWith("#/scan")) {
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
    showView("result");
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
  if (files.length > 1 || QUEUE.bulk) {
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
    QUEUE.bulk
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
  if (QUEUE.bulk) {
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

const QUEUE = {
  jobs: [],            // { id, frontFile, backFile, thumbUrl, status, result, notes, error }
  bulk: false,
  active: 0,
  waitingJobId: null,  // single-mode: auto-open this job's result when it lands
  MAX: 3,              // cap concurrent identify calls (cost + load)
};

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
  try {
    const result = await identifyCard(job.frontFile, job.backFile, job.itemType);
    if (!QUEUE.jobs.includes(job)) return; // discarded mid-flight
    job.result = result;
    job.status = "ready";
  } catch (err) {
    console.error("Background identify failed", err);
    if (!QUEUE.jobs.includes(job)) return;
    job.status = "error";
    job.error = err;
  } finally {
    QUEUE.active = Math.max(0, QUEUE.active - 1);
    renderTray();
    updateNavBadge();
    // Single-mode "wait here": auto-open the result the moment it's ready.
    if (QUEUE.waitingJobId === job.id && QUEUE.jobs.includes(job)) {
      QUEUE.waitingJobId = null;
      if (job.status === "ready") reviewJob(job.id);
      else if (job.status === "error") showSingleError(job);
    }
    pumpQueue();
  }
}

function retryJob(id) {
  const job = QUEUE.jobs.find((j) => j.id === id);
  if (!job) return;
  job.status = "queued";
  job.error = null;
  renderTray();
  pumpQueue();
}

function discardJob(id) {
  const job = QUEUE.jobs.find((j) => j.id === id);
  if (!job) return;
  if (job.thumbUrl) URL.revokeObjectURL(job.thumbUrl);
  QUEUE.jobs = QUEUE.jobs.filter((j) => j.id !== id);
  if (QUEUE.waitingJobId === id) QUEUE.waitingJobId = null;
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
}

// Single-mode panel shown right after a capture: wait, or move on.
function showSingleProcessing(job) {
  if (!scanProcessingEl) return;
  QUEUE.waitingJobId = job.id; // auto-open when this one is ready
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

// Badge on the Scan nav tab showing how many cards are waiting in the queue.
function updateNavBadge() {
  const link = document.querySelector('.navlink[data-nav="scan"]');
  if (!link) return;
  let badge = link.querySelector(".nav-badge");
  const n = QUEUE.jobs.length;
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

if (bulkToggleEl) {
  bulkToggleEl.addEventListener("change", () => {
    QUEUE.bulk = bulkToggleEl.checked;
    if (QUEUE.bulk) {
      hideSingleProcessing();
      if (camSupported() && !cameraStream) startScanCamera();
      else if (cameraStream) setHint("Bulk mode on — tap Capture for each card.");
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
  const highValue = (valueEstimate?.high || 0) >= 250;
  const uncertain = (identified.confidence || 0) < 0.5;
  const inReview = !!state.reviewJobId;
  const moreReady = inReview
    ? QUEUE.jobs.filter((j) => j.status === "ready" && j.id !== state.reviewJobId).length
    : 0;

  el.innerHTML = `
    ${inReview ? `<div class="review-banner">Reviewing an item from your scan queue.${moreReady ? ` ${moreReady} more ready after this.` : ""} Save it to your collection or discard it.</div>` : ""}
    ${highValue ? `<div class="high-value-banner">This may be valuable. Get a professional appraisal before selling.</div>` : ""}
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
      itemType: state.lastIdentified.itemType || "card",
      imageFrontUrl: frontUrl,
      imageBackUrl: backUrl,
      identified: state.lastIdentified.identified,
      valueEstimate: state.lastIdentified.valueEstimate,
      ebayPrices: state.lastIdentified.ebayPrices || null,
      userNotes: state.notes || null,
    });
    if (state.reviewJobId) {
      // Saved a queued card: remove it and step to the next ready one.
      const saved = QUEUE.jobs.find((j) => j.id === state.reviewJobId);
      if (saved?.thumbUrl) URL.revokeObjectURL(saved.thumbUrl);
      QUEUE.jobs = QUEUE.jobs.filter((j) => j.id !== state.reviewJobId);
      state.reviewJobId = null;
      renderTray();
      updateNavBadge();
      reviewNext();
    } else {
      resetScanInputs();
      location.hash = "#/collection";
    }
  } catch (err) {
    console.error(err);
    alert("Save failed. Try again.");
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
  if (IS_DEMO || !currentUser) {
    cardsCache = SAMPLE_CARDS.slice();
    locationsCache = [];
    drawCollection();
    return;
  }
  await loadLocations();
  const snap = await getDocs(
    query(collection(db, "users", currentUser.uid, "cards"), orderBy("createdAt", "desc")),
  );
  cardsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  drawCollection();
}

const sortComparators = {
  newest: (a, b) => tsMs(b.createdAt) - tsMs(a.createdAt),
  oldest: (a, b) => tsMs(a.createdAt) - tsMs(b.createdAt),
  "highest-value": (a, b) => (b.valueEstimate?.high || 0) - (a.valueEstimate?.high || 0),
  "lowest-value": (a, b) => (a.valueEstimate?.low || 0) - (b.valueEstimate?.low || 0),
  "newest-cards": (a, b) => (b.identified?.year || 0) - (a.identified?.year || 0),
  "oldest-cards": (a, b) => (a.identified?.year || 9999) - (b.identified?.year || 9999),
  "player-az": (a, b) => (a.identified?.player || "").localeCompare(b.identified?.player || ""),
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

filtersToggleEl.addEventListener("click", () => {
  filtersPanelEl.hidden = !filtersPanelEl.hidden;
  filtersToggleEl.classList.toggle("active", !filtersPanelEl.hidden);
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
    alert("Nothing to export. Try clearing your filters.");
    return;
  }
  exportCSV(filtered);
});

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
  const highValue = (c.valueEstimate?.high || 0) >= 250;
  const uncertain = (c.identified?.confidence || 0) < 0.5 && !c.identified?.userEdited;

  el.innerHTML = `
    ${IS_DEMO ? `<div class="demo-banner">This is a <strong>sample item</strong>. Editing and deleting are disabled in demo mode.</div>` : ""}
    ${highValue ? `<div class="high-value-banner">This may be valuable. Get a professional appraisal before selling.</div>` : ""}
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
    ${c.locationId && locationName(c.locationId) ? `<div class="location-display">📍 <strong>Location:</strong> ${esc(locationName(c.locationId))}</div>` : ""}
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
      alert("Sign in to add locations.");
      return;
    }
    const raw = prompt('New location name (e.g. "Binder A — Page 3")');
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
      alert("Couldn't add that location. Try again.");
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
  const counts = {};
  try {
    const snap = await getDocs(collection(db, "users", currentUser.uid, "cards"));
    snap.docs.forEach((d) => {
      const lid = d.data().locationId;
      if (lid) counts[lid] = (counts[lid] || 0) + 1;
    });
  } catch (err) {
    console.warn("Couldn't count cards per location", err);
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
      alert("Sign in to add locations.");
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
      alert("Couldn't add that location. Try again.");
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
      const next = prompt("Rename location", loc ? loc.name : "");
      if (next == null) return;
      const name = next.trim();
      if (!name) return;
      try {
        await updateDoc(doc(db, "users", currentUser.uid, "locations", id), { name });
        await renderLocations();
      } catch (err) {
        console.error(err);
        alert("Couldn't rename. Try again.");
      }
    } else if (btn.dataset.act === "delete") {
      const label = loc ? loc.name : "this location";
      if (!confirm(`Delete “${label}”? Cards assigned to it will become unassigned.`)) return;
      try {
        await deleteDoc(doc(db, "users", currentUser.uid, "locations", id));
        await renderLocations();
      } catch (err) {
        console.error(err);
        alert("Couldn't delete. Try again.");
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
            <button type="button" class="control-btn ai-listing-btn" data-ai-slug="${slug}" data-ai-target="#ebay-desc-${slug}">✦ Write a better description with AI</button>
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
      const registration = await navigator.serviceWorker.register("sw.js");

      // When a new SW takes over, reload so the live page runs against fresh
      // assets. skipWaiting() in sw.js means the new SW activates immediately
      // after install, so this fires shortly after a deploy is detected.
      registration.addEventListener("updatefound", () => {
        const newSW = registration.installing;
        if (!newSW) return;
        newSW.addEventListener("statechange", () => {
          if (newSW.state === "activated" && navigator.serviceWorker.controller) {
            window.location.reload();
          }
        });
      });

      // Poll every 60 seconds so a long-open tab eventually catches deploys.
      setInterval(() => registration.update().catch(() => {}), 60_000);
    } catch (err) {
      console.warn("Service worker registration failed:", err);
    }
  });
}
