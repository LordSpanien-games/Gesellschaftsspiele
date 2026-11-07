const socket = io("/erzaehl");

let myPlayerId = sessionStorage.getItem('playerId');
let myRoomId = sessionStorage.getItem('roomId');
let mySentences = [];
let currentIndex = 0;
let currentRoom = null;
let pendingRequest = null;
let callOutCooldown = false;

console.log('playerId:', myPlayerId);
console.log('roomId:', myRoomId);

socket.emit('rejoinRoom', { playerId: myPlayerId, roomId: myRoomId });

socket.on('yourSentences', (sentences) => {
  console.log('Saetze empfangen:', sentences);
  mySentences = sentences;
  currentIndex = 0;
  renderCurrentSentence();
  updateConfirmTargetSelect();
});

socket.on('updateRoom', (room) => {
  currentRoom = room;
  renderScoreboard();
  updateCallOutSelect();
  updateConfirmTargetSelect();
});

socket.on('trophyUpdate', (trophies) => {
  renderTrophies(trophies);
});

socket.on('pointGranted', ({ sentenceIndex, points }) => {
  mySentences[sentenceIndex].used = true;
  currentIndex = sentenceIndex + 1;
  renderCurrentSentence();
  showActionMsg('✅ Punkt erhalten! Gesamt: ' + points, 'success');
});

socket.on('usedRejected', () => {
  showActionMsg('❌ Bestaetigung abgelehnt!', 'fail');
});

socket.on('confirmRequest', ({ requesterId, requesterName, sentence, sentenceIndex, type }) => {
  pendingRequest = { requesterId, sentenceIndex, type };
  const popup = document.getElementById('confirmPopup');
  const calloutArea = document.getElementById('calloutSentenceArea');
  const popupSentence = document.getElementById('popupSentence');

  if (type === 'used') {
    document.getElementById('popupTitle').textContent = '✅ Bestaetigung erbeten!';
    document.getElementById('popupText').textContent = requesterName + ' hat diesen Satz in eurem Gespraech verwendet:';
    popupSentence.textContent = '"' + sentence + '"';
    popupSentence.style.display = 'block';
    calloutArea.style.display = 'none';
  } else {
    document.getElementById('popupTitle').textContent = '🚨 Aufdeckversuch!';
    document.getElementById('popupText').textContent = requesterName + ' glaubt deinen aktuellen Satz erkannt zu haben!';
    popupSentence.style.display = 'none';
    updateConfirmSentenceSelect();
    calloutArea.style.display = 'block';
  }

  popup.style.display = 'flex';
});

socket.on('callOutSuccess', ({ points }) => {
  showActionMsg('🎉 Aufgedeckt! Punkt erhalten! Gesamt: ' + points, 'success');
});

socket.on('callOutFailed', ({ penalty }) => {
  let msg = '❌ Falsch geraten!';
  if (penalty === 'minus') msg += ' -1 Punkt';
  if (penalty === 'cooldown') {
    msg += ' 30 Sek. Sperre';
    callOutCooldown = true;
    setTimeout(() => { callOutCooldown = false; }, 30000);
  }
  showActionMsg(msg, 'fail');
});

socket.on('error', (msg) => {
  showActionMsg('⚠️ ' + msg, 'fail');
});

function requestConfirm() {
  const select = document.getElementById('confirmTargetSelect');
  const targetPlayerId = select.value;
  if (!targetPlayerId) return showActionMsg('⚠️ Bitte Spieler auswaehlen', 'fail');
  if (currentIndex >= mySentences.length) return showActionMsg('⚠️ Keine Saetze mehr offen', 'fail');
  socket.emit('requestConfirm', { targetPlayerId, sentenceIndex: currentIndex });
  showActionMsg('⏳ Warte auf Bestaetigung...', 'success');
}

function callOut() {
  if (callOutCooldown) return showActionMsg('⏳ Noch gesperrt!', 'fail');
  const select = document.getElementById('callOutPlayer');
  const targetPlayerId = select.value;
  if (!targetPlayerId) return showActionMsg('⚠️ Bitte Spieler auswaehlen', 'fail');
  socket.emit('callOut', { targetPlayerId });
  showActionMsg('⏳ Warte auf Bestaetigung...', 'success');
}

function confirmAction() {
  if (!pendingRequest) return;
  if (pendingRequest.type === 'used') {
    socket.emit('confirmUsed', { requesterId: pendingRequest.requesterId, sentenceIndex: pendingRequest.sentenceIndex });
  } else {
    const select = document.getElementById('confirmSentenceSelect');
    const sentenceIndex = parseInt(select.value);
    if (isNaN(sentenceIndex)) return showActionMsg('⚠️ Bitte Satz auswaehlen', 'fail');
    socket.emit('callOutConfirm', { callerId: pendingRequest.requesterId, sentenceIndex });
  }
  document.getElementById('confirmPopup').style.display = 'none';
  pendingRequest = null;
}

function rejectAction() {
  if (!pendingRequest) return;
  if (pendingRequest.type === 'used') {
    socket.emit('rejectUsed', { requesterId: pendingRequest.requesterId });
  } else {
    socket.emit('callOutReject', { callerId: pendingRequest.requesterId });
  }
  document.getElementById('confirmPopup').style.display = 'none';
  pendingRequest = null;
}

function renderCurrentSentence() {
  const sentenceBox = document.getElementById('currentSentence');
  const counter = document.getElementById('sentenceCounter');
  const claimArea = document.getElementById('claimArea');
  const allDone = document.getElementById('allDone');

  if (mySentences.length === 0) {
    sentenceBox.textContent = 'Warte auf Saetze...';
    return;
  }

  if (currentIndex >= mySentences.length) {
    sentenceBox.textContent = '';
    counter.textContent = '';
    claimArea.style.display = 'none';
    allDone.style.display = 'block';
    return;
  }

  sentenceBox.textContent = '"' + mySentences[currentIndex].text + '"';
  counter.textContent = 'Satz ' + (currentIndex + 1) + ' von ' + mySentences.length;
  claimArea.style.display = 'block';
  allDone.style.display = 'none';
}

function updateConfirmTargetSelect() {
  const select = document.getElementById('confirmTargetSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">-- Spieler waehlen --</option>';
  if (!currentRoom) return;
  for (const pid in currentRoom.players) {
    if (pid === myPlayerId) continue;
    const opt = document.createElement('option');
    opt.value = pid;
    opt.textContent = currentRoom.players[pid].name;
    if (pid === current) opt.selected = true;
    select.appendChild(opt);
  }
}

function updateCallOutSelect() {
  const select = document.getElementById('callOutPlayer');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">-- Spieler waehlen --</option>';
  if (!currentRoom) return;
  for (const pid in currentRoom.players) {
    if (pid === myPlayerId) continue;
    const opt = document.createElement('option');
    opt.value = pid;
    opt.textContent = currentRoom.players[pid].name;
    if (pid === current) opt.selected = true;
    select.appendChild(opt);
  }
}

function updateConfirmSentenceSelect() {
  const select = document.getElementById('confirmSentenceSelect');
  if (!select) return;
  select.innerHTML = '<option value="">-- Satz waehlen --</option>';
  mySentences.forEach((s, i) => {
    if (!s.used) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = '"' + s.text + '"';
      select.appendChild(opt);
    }
  });
}

function renderScoreboard() {
  const container = document.getElementById('scoreboard');
  container.innerHTML = '';
  if (!currentRoom) return;
  const sorted = Object.values(currentRoom.players).sort((a, b) => b.points - a.points);
  sorted.forEach(p => {
    const div = document.createElement('div');
    div.className = 'scoreItem';
    div.innerHTML = '<span>' + p.name + '</span><span>🏆 ' + p.points + '</span>';
    container.appendChild(div);
  });
}

function renderTrophies(trophies) {
  const container = document.getElementById('trophyBoard');
  container.innerHTML = '';
  if (trophies.length === 0) {
    container.innerHTML = '<p style="color:#aaa;font-size:0.85rem">Noch keine Entdeckungen</p>';
    return;
  }
  trophies.slice().reverse().forEach(t => {
    const div = document.createElement('div');
    div.className = 'trophyItem';
    const time = new Date(t.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = '<div class="trophyWho">🔍 ' + t.discoveredBy + ' entdeckte ' + t.player + '</div><div class="trophySentence">&quot;' + t.sentence + '&quot;</div><div style="color:#555;font-size:0.75rem">' + time + '</div>';
    container.appendChild(div);
  });
}

function showActionMsg(msg, type) {
  const el = document.getElementById('actionMsg');
  el.textContent = msg;
  el.className = 'actionMsg ' + type;
  setTimeout(() => { el.textContent = ''; el.className = 'actionMsg'; }, 4000);
}
