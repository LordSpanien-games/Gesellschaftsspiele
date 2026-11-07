const fs = require('fs');
const path = require('path');
const HISTORY_FILE = path.join(__dirname, 'data', 'playerhistory.json');

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return {};
  const raw = fs.readFileSync(HISTORY_FILE, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

function addToHistory(playerName, items) {
  const history = loadHistory();
  if (!history[playerName]) history[playerName] = [];
  items.forEach(item => {
    if (!history[playerName].includes(item)) history[playerName].push(item);
  });
  saveHistory(history);
}

function getKnownItems(playerName) {
  const history = loadHistory();
  return history[playerName] || [];
}

function getKnownCountForItem(item) {
  const history = loadHistory();
  let count = 0;
  for (const player in history) {
    if (history[player].includes(item)) count++;
  }
  return count;
}

function getRandomSentences(count) {
  let raw = fs.readFileSync(path.join(__dirname, 'data', 'sentences.json'), 'utf8');
  raw = raw.replace(/^\uFEFF/, '');
  const sentences = JSON.parse(raw);
  const available = sentences.filter(s => getKnownCountForItem(s) < 2);
  const shuffled = [...available].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function getRandomWords(count) {
  let raw = fs.readFileSync(path.join(__dirname, 'data', 'words.json'), 'utf8');
  raw = raw.replace(/^\uFEFF/, '');
  const words = JSON.parse(raw);
  const available = words.filter(w => getKnownCountForItem(w) < 2);
  const shuffled = [...available].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

module.exports = { getRandomSentences, getRandomWords, addToHistory, getKnownItems };