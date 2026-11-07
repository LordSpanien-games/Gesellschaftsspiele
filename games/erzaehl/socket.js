const { getRandomSentences, getRandomWords, addToHistory, getKnownItems } = require('./sentences');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const SESSION_DIR = path.join(__dirname, 'data', 'sessions');
const rooms = {};

function generateShortId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}

function generatePlayerId() {
  return crypto.randomBytes(4).toString('hex');
}

function saveSession(room) {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSION_DIR, room.id + '.json'), JSON.stringify(room, null, 2), 'utf8');
}

function loadSession(roomId) {
  const filePath = path.join(SESSION_DIR, roomId + '.json');
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  }
  return null;
}

function deleteSession(roomId) {
  const filePath = path.join(SESSION_DIR, roomId + '.json');
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function sanitizeRoom(room) {
  const safe = { ...room, players: {} };
  for (const pid in room.players) {
    safe.players[pid] = {
      id:            room.players[pid].id,
      name:          room.players[pid].name,
      points:        room.players[pid].points,
      sentenceCount: room.players[pid].sentences.length
    };
  }
  return safe;
}

function sendToPlayer(io, roomId, playerId, event, data) {
  for (const sid of io.adapter.rooms.get(roomId) || []) {
    const s = io.sockets.get(sid);
    if (s && s.data.playerId === playerId) s.emit(event, data);
  }
}

module.exports = (io) => {
  io.on('connection', (socket) => {

    socket.on('createRoom', ({ playerName, maxPlayers, sentencesPerPlayer, penalty, customId, gameMode }) => {
      let roomId = customId ? customId.toUpperCase().trim() : generateShortId();
      if (rooms[roomId]) return socket.emit('error', 'Diese ID existiert bereits');
      const playerId = generatePlayerId();
      rooms[roomId] = {
        id: roomId, host: playerId, maxPlayers, sentencesPerPlayer,
        penalty, gameMode: gameMode || 'sentences',
        players: {}, trophies: [], started: false, createdAt: Date.now()
      };
      rooms[roomId].players[playerId] = { id: playerId, name: playerName, sentences: [], points: 0 };
      socket.join(roomId);
      socket.data = { roomId, playerId };
      saveSession(rooms[roomId]);
      socket.emit('roomCreated', { roomId, playerId });
      io.to(roomId).emit('updateRoom', sanitizeRoom(rooms[roomId]));
    });

    socket.on('joinRoom', ({ playerName, roomId }) => {
      const rid = roomId.toUpperCase().trim();
      if (!rooms[rid]) { const loaded = loadSession(rid); if (loaded) rooms[rid] = loaded; }
      const room = rooms[rid];
      if (!room) return socket.emit('error', 'Raum nicht gefunden');
      const existingPlayer = Object.values(room.players).find(p => p.name.toLowerCase() === playerName.toLowerCase());
      if (existingPlayer) return socket.emit('nameExists', { existingPlayerId: existingPlayer.id, roomId: rid });
      const hasPoints = Object.values(room.players).some(p => p.points > 0);
      if (room.started && hasPoints) return socket.emit('error', 'Spiel laeuft - keine neuen Spieler moeglich');
      if (Object.keys(room.players).length >= room.maxPlayers) return socket.emit('error', 'Raum ist voll');
      const playerId = generatePlayerId();
      room.players[playerId] = { id: playerId, name: playerName, sentences: [], points: 0 };
      socket.join(rid);
      socket.data = { roomId: rid, playerId };
      saveSession(room);
      socket.emit('roomJoined', { roomId: rid, playerId });
      io.to(rid).emit('updateRoom', sanitizeRoom(room));
    });

    socket.on('rejoinRoom', ({ playerId, roomId }) => {
      const rid = roomId ? roomId.toUpperCase().trim() : null;
      if (!rid) return;
      if (!rooms[rid]) { const loaded = loadSession(rid); if (loaded) rooms[rid] = loaded; }
      const room = rooms[rid];
      if (!room || !room.players[playerId]) return;
      socket.join(rid);
      socket.data = { roomId: rid, playerId };
      socket.emit('rejoinConfirm', { isHost: room.host === playerId, roomId: rid, playerId, started: room.started });
      socket.emit('yourSentences', room.players[playerId].sentences);
      socket.emit('updateRoom', sanitizeRoom(room));
      socket.emit('trophyUpdate', room.trophies);
      if (room.started) socket.emit('gameStarted');
    });

    socket.on('startGame', () => {
      const { roomId, playerId } = socket.data;
      const room = rooms[roomId];
      if (!room) return;
      if (room.host !== playerId) return socket.emit('error', 'Nur der Host kann starten');
      const usedTexts = [];
      for (const pid in room.players) {
        if (!room.players[pid].sentences || room.players[pid].sentences.length === 0) {
          const items = room.gameMode === 'words'
            ? getRandomWords(room.sentencesPerPlayer)
            : getRandomSentences(room.sentencesPerPlayer);
          const unique = items.filter(s => !usedTexts.includes(s));
          room.players[pid].sentences = unique.slice(0, room.sentencesPerPlayer).map(s => {
            usedTexts.push(s);
            return { text: s, used: false };
          });
          addToHistory(room.players[pid].name, room.players[pid].sentences.map(s => s.text));
        }
      }
      room.started = true;
      saveSession(room);
      io.to(roomId).emit('gameStarted');
      for (const sid of io.adapter.rooms.get(roomId) || []) {
        const s = io.sockets.get(sid);
        if (s && room.players[s.data.playerId]) s.emit('yourSentences', room.players[s.data.playerId].sentences);
      }
      io.to(roomId).emit('updateRoom', sanitizeRoom(room));
    });

    socket.on('requestConfirm', ({ targetPlayerId, sentenceIndex }) => {
      const { roomId, playerId } = socket.data;
      const room = rooms[roomId];
      if (!room) return;
      const requester = room.players[playerId];
      const sentence  = requester.sentences[sentenceIndex];
      if (!sentence || sentence.used) return;
      sendToPlayer(io, roomId, targetPlayerId, 'confirmRequest', {
        requesterId: playerId, requesterName: requester.name,
        sentence: sentence.text, sentenceIndex, type: 'used'
      });
    });

    socket.on('confirmUsed', ({ requesterId, sentenceIndex }) => {
      const { roomId } = socket.data;
      const room = rooms[roomId];
      if (!room) return;
      const requester = room.players[requesterId];
      if (!requester) return;
      const sentence = requester.sentences[sentenceIndex];
      if (!sentence || sentence.used) return;
      sentence.used    = true;
      requester.points += 1;
      saveSession(room);
      sendToPlayer(io, roomId, requesterId, 'pointGranted', { sentenceIndex, points: requester.points });
      io.to(roomId).emit('updateRoom', sanitizeRoom(room));
    });

    socket.on('rejectUsed', ({ requesterId }) => {
      const { roomId } = socket.data;
      const room = rooms[roomId];
      if (!room) return;
      sendToPlayer(io, roomId, requesterId, 'usedRejected', {});
    });

    socket.on('callOut', ({ targetPlayerId }) => {
      const { roomId, playerId } = socket.data;
      const room = rooms[roomId];
      if (!room) return;
      const caller = room.players[playerId];
      const target = room.players[targetPlayerId];
      if (!target) return;
      const currentSentence = target.sentences.find(s => !s.used);
      if (currentSentence) {
        const knownByCaller = getKnownItems(caller.name);
        if (knownByCaller.includes(currentSentence.text)) return socket.emit('error', 'Du kennst diesen Satz bereits - kein Aufdecken moeglich');
      }
      sendToPlayer(io, roomId, targetPlayerId, 'confirmRequest', {
        requesterId: playerId, requesterName: caller.name, type: 'callout'
      });
    });

    socket.on('callOutConfirm', ({ callerId, sentenceIndex }) => {
      const { roomId, playerId } = socket.data;
      const room   = rooms[roomId];
      if (!room) return;
      const caller = room.players[callerId];
      const target = room.players[playerId];
      if (!caller || !target) return;
      const sentence = target.sentences[sentenceIndex];
      if (!sentence) return;
      caller.points += 1;
      room.trophies.push({ discoveredBy: caller.name, player: target.name, sentence: sentence.text, timestamp: Date.now() });
      saveSession(room);
      sendToPlayer(io, roomId, callerId, 'callOutSuccess', { points: caller.points });
      io.to(roomId).emit('updateRoom', sanitizeRoom(room));
      io.to(roomId).emit('trophyUpdate', room.trophies);
    });

    socket.on('callOutReject', ({ callerId }) => {
      const { roomId } = socket.data;
      const room = rooms[roomId];
      if (!room) return;
      const caller = room.players[callerId];
      if (room.penalty === 'minus') {
        caller.points = Math.max(0, caller.points - 1);
        saveSession(room);
        io.to(roomId).emit('updateRoom', sanitizeRoom(room));
      }
      sendToPlayer(io, roomId, callerId, 'callOutFailed', { penalty: room.penalty });
    });

    socket.on('endSession', () => {
      const { roomId, playerId } = socket.data;
      const room = rooms[roomId];
      if (!room) return;
      if (room.host !== playerId) return socket.emit('error', 'Nur der Host kann die Session beenden');
      deleteSession(roomId);
      delete rooms[roomId];
      io.to(roomId).emit('sessionEnded');
    });

    socket.on('disconnect', () => {
      const { roomId } = socket.data || {};
      if (!roomId || !rooms[roomId]) return;
      saveSession(rooms[roomId]);
    });

  });
};
