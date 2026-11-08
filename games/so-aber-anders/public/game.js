const socket = io("/so-aber-anders");
const params = new URLSearchParams(window.location.search);
const sessionCode = params.get("code");
const playerName = decodeURIComponent(params.get("name"));
const isHost = params.get("host") === "true";

let timerInterval = null;
let settings = null;
let currentLetter = null;

socket.emit("rejoinSession", { code: sessionCode, name: playerName });

socket.on("newTurn", (data) => {
  settings = data.settings;
  document.getElementById("round-display").textContent =
    "Runde " + data.round;
  if (data.letter) showLetter(data.letter);
  if (data.explainer === playerName) {
    showScreen("screen-explainer");
    document.getElementById("term-display").textContent = "";
    document.getElementById("forbidden-list").innerHTML = "";
    document.getElementById("timer-display").textContent = "";
    // Passen-Button: sichtbar und mit der Konsequenz beschriftet
    const skipBtn = document.getElementById("btn-skip");
    skipBtn.style.display = settings.skipAllowed ? "block" : "none";
    skipBtn.textContent = settings.minusOnSkip
      ? "⏭️ Passen (−1 Punkt)"
      : "⏭️ Passen (keine Punkte)";
    const skipHint = document.getElementById("skip-hint");
    skipHint.textContent = settings.skipAllowed
      ? (settings.minusOnSkip
          ? "Wird das Wort nicht erraten, kannst du passen – das kostet 1 Punkt."
          : "Wird das Wort nicht erraten, kannst du passen – das kostet keine Punkte.")
      : "Passen ist in diesem Spiel nicht erlaubt – jedes Wort muss erraten werden.";
  } else if (data.controller === playerName) {
    showScreen("screen-controller");
    document.getElementById("controller-forbidden").innerHTML = "";
  } else {
    showScreen("screen-waiting");
    document.getElementById("current-explainer").textContent =
      "🗣️ " + data.explainer + " erklaert gerade...";
  }
  updateScoreBoard(data.players);
});

socket.on("newWord", (data) => {
  document.getElementById("term-display").textContent = data.term;
  const forbiddenList = document.getElementById("forbidden-list");
  forbiddenList.innerHTML = "";
  if (data.forbidden && data.forbidden.length > 0) {
    forbiddenList.innerHTML = "<strong>🚫 Verbotene Woerter:</strong><br>";
    data.forbidden.forEach(w => {
      const span = document.createElement("span");
      span.className = "forbidden-word";
      span.textContent = w + " ";
      forbiddenList.appendChild(span);
    });
  }
  if (data.letter) {
    currentLetter = data.letter;
    showLetter(data.letter);
  }
  // Buchstaben-Helfer zuruecksetzen
  const input = document.getElementById("phrase-input");
  if (input) {
    input.value = "";
    document.getElementById("phrase-preview").innerHTML = "";
  }
  // Der Timer laeuft unabhaengig vom Wort weiter und wird vom Server
  // gesteuert - hier wird er deshalb nicht neu gestartet.
});

// Der Server steuert den Timer. Der Client zeigt nur an, was kommt.
socket.on("timerState", (data) => {
  if (!data.active) {
    stopTimer();
    const display = document.getElementById("timer-display");
    if (display) display.textContent = "";
    return;
  }
  startTimer(data.endsAt);
});

socket.on("timerExpired", () => {
  const display = document.getElementById("timer-display");
  if (display) display.textContent = "⏱️ Zeit abgelaufen!";
});

// Tabuwörter gehen separat an den Kontrolleur (nicht an die Rater).
socket.on("forbiddenWords", (data) => {
  const ctrlForbidden = document.getElementById("controller-forbidden");
  if (!ctrlForbidden) return;
  ctrlForbidden.innerHTML = "";
  if (data.forbidden && data.forbidden.length > 0) {
    ctrlForbidden.innerHTML = "<strong>🚫 Achte auf diese Woerter:</strong><br>";
    data.forbidden.forEach(w => {
      const span = document.createElement("span");
      span.className = "forbidden-word";
      span.textContent = w + " ";
      ctrlForbidden.appendChild(span);
    });
  }
});

// --- Moeser Mamster: Buchstabenphase ---

socket.on("letterPhase", (data) => {
  showScreen("screen-letter");
  document.getElementById("letter-input").value = "";
  document.getElementById("letter-progress").textContent =
    data.total > 0 ? "0 von " + data.total + " Vorschlägen" : "";
});

socket.on("letterProgress", (data) => {
  document.getElementById("letter-progress").textContent =
    "✅ " + data.submitted + " von " + data.total + " Vorschlägen";
});

socket.on("letterChosen", (data) => {
  currentLetter = data.letter;
  document.getElementById("letter-progress").textContent =
    "🎲 Gewählt: " + data.letter;
  // Der Bildschirm wechselt, sobald newTurn eintrifft.
});

socket.on("scoreUpdate", (players) => {
  updateScoreBoard(players);
});

// Ein Wort wurde uebersprungen - die Gruppe soll das wissen.
socket.on("wordSkipped", (data) => {
  const msg = data.penalty
    ? "⏭️ " + data.skippedBy + " hat gepasst (−1 Punkt)"
    : "⏭️ " + data.skippedBy + " hat gepasst (keine Punkte)";
  const status = document.getElementById("status-msg");
  if (status) {
    status.textContent = msg;
    status.classList.add("visible");
    setTimeout(() => {
      status.classList.remove("visible");
      status.textContent = "";
    }, 3000);
  }
});

socket.on("roundEnd", (data) => {
  stopTimer();
  showScreen("screen-waiting");
  document.getElementById("current-explainer").textContent =
    "✅ Runde " + data.round + " beendet! Naechste Runde startet...";
  updateScoreBoard(data.players);
});

socket.on("gameOver", (players) => {
  showScreen("screen-gameover");
  stopTimer();
  const final = document.getElementById("final-score");
  final.innerHTML = "";
  const sorted = [...players].sort((a, b) => b.score - a.score);
  sorted.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "score-card";
    card.innerHTML =
      "<div class='name'>" + (i === 0 ? "🏆 " : "") + p.name + "</div>" +
      "<div class='points'>" + p.score + "</div>";
    final.appendChild(card);
  });
  if (isHost) {
    document.getElementById("btn-restart").style.display = "block";
  }
});

// Zurueck zur Lobby – gleiche Session, neue Runde moeglich
socket.on("backToLobby", (session) => {
  window.location.href = "index.html?code=" + sessionCode +
    "&name=" + encodeURIComponent(playerName) +
    "&host=" + isHost +
    "&rejoin=true";
});

socket.on("error", (msg) => showError(msg));

function wordCorrect() {
  stopTimer();
  socket.emit("wordCorrect", { code: sessionCode });
}

function wordSkip() {
  stopTimer();
  socket.emit("wordSkip", { code: sessionCode });
}

function reportViolation() {
  stopTimer();
  socket.emit("violation", { code: sessionCode });
}

function restartGame() {
  socket.emit("restartGame", { code: sessionCode });
}

function submitLetter() {
  const input = document.getElementById("letter-input");
  const letter = input.value.trim().toUpperCase();
  if (!/^[A-Z]$/.test(letter)) {
    showError("Bitte genau einen Buchstaben A-Z eingeben.");
    return;
  }
  socket.emit("submitLetter", { code: sessionCode, letter });
  input.value = "";
  input.disabled = true;
}

// --- Moeser Mamster: Satz-Pruefung ---
// Jedes Wort des Satzes muss mit dem geforderten Buchstaben beginnen.
// "man lebt darin" mit B wird zu "Ban bebt barin".

function showLetter(letter) {
  currentLetter = letter;

  const display = document.getElementById("letter-display");
  if (display) display.innerHTML = "<strong>🔤 Dein Buchstabe: " + letter + "</strong>";

  const helper = document.getElementById("letter-helper");
  if (helper) helper.style.display = "block";
  const helperLetter = document.getElementById("letter-helper-letter");
  if (helperLetter) helperLetter.textContent = letter;

  const waiting = document.getElementById("waiting-letter");
  if (waiting) waiting.innerHTML = "<p>🔤 Buchstabe dieser Runde: <strong>" + letter + "</strong></p>";

  const ctrl = document.getElementById("controller-letter");
  if (ctrl) ctrl.innerHTML = "<p>🔤 Buchstabe: <strong>" + letter + "</strong></p>";
}

// Prueft einen Satz und markiert Woerter, die nicht mit dem Buchstaben beginnen.
function checkPhrase() {
  const input = document.getElementById("phrase-input");
  const preview = document.getElementById("phrase-preview");
  if (!input || !preview) return;

  const phrase = input.value.trim();
  if (!phrase || !currentLetter) {
    preview.innerHTML = "";
    return;
  }

  const letter = currentLetter.toUpperCase();
  const words = phrase.split(/\s+/).filter(Boolean);
  let invalidCount = 0;

  const parts = words.map((word, index) => {
    // Fuehrende Satzzeichen und Anfuehrungszeichen ignorieren
    const match = word.match(/^([^\p{L}]*)(\p{L})(.*)$/u);
    if (!match) return word;
    const prefix = match[1];
    const first = match[2];
    const rest = match[3];
    const ok = first.toUpperCase() === letter;
    if (!ok) invalidCount++;
    // Der erste Buchstabe wird durch den geforderten Buchstaben ersetzt.
    // Das erste Wort des Satzes beginnt gross, bei allen weiteren bleibt die
    // Schreibweise des Originals erhalten (gross -> gross, klein -> klein).
    const replacement = index === 0
      ? letter
      : (first === first.toUpperCase() ? letter : letter.toLowerCase());
    const rewritten = prefix + replacement + rest;
    const span = document.createElement("span");
    span.className = ok ? "phrase-word" : "phrase-word phrase-invalid";
    span.textContent = rewritten;
    if (!ok) span.title = "Beginnt nicht mit " + letter;
    return span;
  });

  preview.innerHTML = "";
  const label = document.createElement("div");
  label.className = "hint";
  label.textContent = invalidCount === 0
    ? "✅ Alle Wörter beginnen mit " + letter + " – so kannst du es sagen:"
    : "⚠️ " + invalidCount + " Wörter beginnen nicht mit " + letter + ":";
  preview.appendChild(label);

  const sentence = document.createElement("div");
  sentence.className = "phrase-sentence";
  parts.forEach((span, i) => {
    sentence.appendChild(span);
    if (i < parts.length - 1) sentence.appendChild(document.createTextNode(" "));
  });
  preview.appendChild(sentence);
}

// Startet die Anzeige eines servergesteuerten Countdown.
// Der Server liefert den absoluten Endzeitpunkt - so zeigen alle Spieler
// dieselbe Restzeit, unabhaengig von lokalen Uhr- oder Latenzabweichungen.
function startTimer(endsAt) {
  stopTimer();
  const display = document.getElementById("timer-display");
  if (!display) return;

  const tick = () => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    display.textContent = "⏱️ " + remaining + "s";
    if (remaining <= 0) stopTimer();
  };
  tick();
  timerInterval = setInterval(tick, 500);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function showScreen(id) {
  ["screen-waiting","screen-explainer","screen-controller","screen-gameover","screen-letter"]
    .forEach(s => document.getElementById(s).style.display = "none");
  document.getElementById(id).style.display = "block";
}

function updateScoreBoard(players) {
  const board = document.getElementById("score-board");
  if (!board) return;
  board.innerHTML = "";
  players.forEach(p => {
    const card = document.createElement("div");
    card.className = "score-card";
    card.innerHTML =
      "<div class='name'>" + p.name + "</div>" +
      "<div class='points'>" + p.score + "</div>";
    board.appendChild(card);
  });
}

function showError(msg) {
  document.getElementById("error-msg").textContent = msg;
  setTimeout(() => document.getElementById("error-msg").textContent = "", 3000);
}

// Live-Pruefung des Satzes im Erklärer-Screen
document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("phrase-input");
  if (input) input.addEventListener("input", checkPhrase);
});
