const socket = io("/so-aber-anders");
let sessionCode = null;
let playerName = null;
let isHost = false;

// Rejoin nach Nochmal spielen
const params = new URLSearchParams(window.location.search);
if (params.get("rejoin") === "true") {
  sessionCode = params.get("code");
  playerName = decodeURIComponent(params.get("name"));
  isHost = params.get("host") === "true";
  socket.emit("rejoinSession", { code: sessionCode, name: playerName });
}

function showStart() {
  hide(["screen-create", "screen-join", "screen-lobby"]);
  show("screen-start");
}

function showCreate() {
  playerName = document.getElementById("player-name").value.trim();
  if (!playerName) { showError("Bitte Namen eingeben!"); return; }
  hide(["screen-start", "screen-join", "screen-lobby"]);
  show("screen-create");
}

function showJoin() {
  playerName = document.getElementById("player-name").value.trim();
  if (!playerName) { showError("Bitte Namen eingeben!"); return; }
  hide(["screen-start", "screen-create", "screen-lobby"]);
  show("screen-join");
}

function createSession() {
  const settings = {
    mode:             document.getElementById("setting-mode").value,
    rotation:         document.getElementById("setting-rotation").value,
    timer:            document.getElementById("setting-timer").value === "on",
    timerDuration:    parseInt(document.getElementById("setting-timer-duration").value),
    timerScope:       document.getElementById("setting-timer-scope").value,
    taboo:            document.getElementById("setting-taboo").value === "on",
    tabooCount:       parseInt(document.getElementById("setting-taboo-count").value),
    skipAllowed:      document.getElementById("setting-skip").value === "on",
    minusOnSkip:      document.getElementById("setting-minus-skip").value === "on",
    minusOnViolation: document.getElementById("setting-minus-violation").value === "on",
    endMode:          document.getElementById("setting-endmode").value,
    rounds:           parseInt(document.getElementById("setting-rounds").value),
    targetScore:      parseInt(document.getElementById("setting-target-score").value),
    wordsPerRound:    parseInt(document.getElementById("setting-words-per-round").value),
    wordlist:         document.getElementById("setting-wordlist").value,
    // Moeser Mamster
    moeserMamster:    document.getElementById("setting-moeser-mamster").value === "on",
    letterMode:       document.getElementById("setting-letter-mode").value,
    debugMode:        document.getElementById("setting-debug-mode").value === "on"
  };
  socket.emit("createSession", { name: playerName, settings });
}

function joinSession() {
  const code = document.getElementById("join-code").value.trim().toUpperCase();
  if (!code) { showError("Bitte Code eingeben!"); return; }
  sessionCode = code;
  socket.emit("joinSession", { code, name: playerName });
}

function startGame() {
  socket.emit("startGame", { code: sessionCode });
}

socket.on("sessionCreated", (data) => {
  sessionCode = data.code;
  isHost = true;
  document.getElementById("session-code-display").textContent = sessionCode;
  document.getElementById("btn-start").style.display = "block";
  hide(["screen-start", "screen-create", "screen-join"]);
  show("screen-lobby");
});

socket.on("updateLobby", (session) => {
  sessionCode = session.code;
  document.getElementById("session-code-display").textContent = session.code;

  // Teams anzeigen
  const teamContainer = document.getElementById("team-list");
  teamContainer.innerHTML = "";

  // Alle Team-IDs sammeln (auch leere für Anzeige)
  const teamIds = Object.keys(session.teams);

  teamIds.forEach(teamId => {
    const team = session.teams[teamId];
    const members = session.players.filter(p => p.teamId === teamId);
    const isCreator = team.creator === socket.id;

    const card = document.createElement("div");
    card.className = "team-card";
    card.innerHTML =
      "<div class=\"team-header\">" +
      "<input type=\"text\" class=\"team-name-input\" value=\"" + team.name + "\" " +
      (isCreator ? "" : "disabled") + " placeholder=\"Teamname\">" +
      (isCreator ? "<button class=\"btn-small\" onclick=\"setTeamName('" + teamId + "', this.parentElement.querySelector('.team-name-input').value)\">✏️</button>" : "") +
      "</div>" +
      "<div class=\"team-members\">" +
      members.map(m => "<span class=\"member\">" + m.name + (m.id === session.host ? " 👑" : "") + "</span>").join("") +
      "</div>";
    teamContainer.appendChild(card);
  });

  // Spieler ohne Team: Auswahl anzeigen
  const withoutTeam = session.players.filter(p => !p.teamId);
  const noTeamContainer = document.getElementById("no-team-players");
  noTeamContainer.innerHTML = "<h3>👥 Ohne Team</h3>";
  withoutTeam.forEach(p => {
    const isMe = p.id === socket.id;
    const select = document.createElement("select");
    select.id = "team-select-" + p.id;
    select.innerHTML = "<option value=\"\">Team wählen...</option>" +
      teamIds.map(tid => "<option value=\"" + tid + "\">" + session.teams[tid].name + "</option>").join("") +
      "<option value=\"new\">➕ Neues Team erstellen</option>";
    if (!isMe) select.disabled = true;

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Teamname (optional)";
    nameInput.style.display = "none";
    nameInput.id = "team-name-input-" + p.id;

    select.onchange = function() {
      if (select.value === "new") {
        nameInput.style.display = "inline-block";
      } else {
        nameInput.style.display = "none";
      }
    };

    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = isMe ? "👤 Team wählen" : "";
    btn.style.display = isMe ? "inline-block" : "none";
    btn.onclick = () => {
      const tid = select.value;
      const tname = tid === "new" ? nameInput.value : null;
      socket.emit("selectTeam", { code: sessionCode, teamId: tid, teamName: tname });
    };

    const div = document.createElement("div");
    div.className = "player-team-select";
    div.textContent = p.name + (p.id === session.host ? " 👑" : "") + ": ";
    div.appendChild(select);
    div.appendChild(nameInput);
    div.appendChild(btn);
    noTeamContainer.appendChild(div);
  });

  // Start-Button: nur Host, und nur wenn alle Teams gesetzt (oder Debug-Modus)
  const startBtn = document.getElementById("btn-start");
  if (isHost) {
    startBtn.style.display = "block";
    const allHaveTeam = session.players.every(p => p.teamId);
    const enoughTeams = session.settings.debugMode || Object.keys(session.teams).length >= 2;
    startBtn.disabled = !(allHaveTeam && enoughTeams);
    if (!allHaveTeam) startBtn.title = "Alle Spieler müssen einem Team zugeordnet sein.";
    if (!enoughTeams && !session.settings.debugMode) startBtn.title = "Es müssen mindestens 2 Teams existieren.";
  } else {
    startBtn.style.display = "none";
  }

  hide(["screen-start", "screen-create", "screen-join"]);
  show("screen-lobby");
});

socket.on("gameStarted", () => {
  window.location.href = "game.html?code=" + sessionCode +
    "&name=" + encodeURIComponent(playerName) +
    "&host=" + isHost;
});

socket.on("error", (msg) => showError(msg));

function show(id) {
  document.getElementById(id).style.display = "block";
}

function hide(ids) {
  ids.forEach(id => document.getElementById(id).style.display = "none");
}

function showError(msg) {
  document.getElementById("error-msg").textContent = msg;
  setTimeout(() => document.getElementById("error-msg").textContent = "", 3000);
}

function selectTeam(teamId, teamName) {
  socket.emit("selectTeam", { code: sessionCode, teamId: teamId, teamName: teamName });
}

function setTeamName(teamId, name) {
  socket.emit("setTeamName", { code: sessionCode, teamId: teamId, name: name });
}