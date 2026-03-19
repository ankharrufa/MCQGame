const roomCode = new URLSearchParams(window.location.search).get("room") || "main";
const tokenKey = `hoc_player_token_${roomCode}`;
let playerToken = localStorage.getItem(tokenKey) || "";
let statePoller = null;

const roomLabel = document.getElementById("roomLabel");
const joinCard = document.getElementById("joinCard");
const gameCard = document.getElementById("gameCard");
const leaderboardCard = document.getElementById("leaderboardCard");
const joinForm = document.getElementById("joinForm");
const nameInput = document.getElementById("nameInput");
const messageEl = document.getElementById("message");

const phaseTitle = document.getElementById("phaseTitle");
const statusLine = document.getElementById("statusLine");
const timerEl = document.getElementById("timer");

const lobbySection = document.getElementById("lobbySection");
const lobbyInfo = document.getElementById("lobbyInfo");
const startRoundBtn = document.getElementById("startRoundBtn");

const questionSection = document.getElementById("questionSection");
const caseStudy = document.getElementById("caseStudy");
const questionText = document.getElementById("questionText");
const assignedOption = document.getElementById("assignedOption");

const conflictSection = document.getElementById("conflictSection");
const conflictWaiting = document.getElementById("conflictWaiting");

const leaderboardBody = document.getElementById("leaderboardBody");

roomLabel.textContent = `Room: ${roomCode}`;

function showMessage(text, kind = "") {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`.trim();
}

async function api(action, payload = {}) {
  const response = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, roomCode, playerToken, payload }),
  });

  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

function setVisibilityForJoined(joined) {
  joinCard.classList.toggle("hidden", joined);
  gameCard.classList.toggle("hidden", !joined);
  leaderboardCard.classList.toggle("hidden", !joined);
}

function renderLeaderboard(players) {
  leaderboardBody.innerHTML = "";
  players.forEach((player, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${index + 1}</td><td>${player.name}</td><td>${player.score}</td>`;
    leaderboardBody.appendChild(row);
  });
}

function renderTimer(deadlineIso) {
  if (!deadlineIso) {
    timerEl.classList.add("hidden");
    return;
  }
  timerEl.classList.remove("hidden");
  const seconds = Math.max(0, Math.ceil((new Date(deadlineIso).getTime() - Date.now()) / 1000));
  timerEl.textContent = `${seconds}s`;
}

function clearSections() {
  lobbySection.classList.add("hidden");
  questionSection.classList.add("hidden");
  conflictSection.classList.add("hidden");
}

function renderState(data) {
  const { view, leaderboard } = data;
  renderLeaderboard(leaderboard || []);
  clearSections();
  renderTimer(view.deadline || null);

  phaseTitle.textContent = view.phaseLabel;
  statusLine.textContent = view.statusMessage || "";

  if (view.phase === "lobby" || view.phase === "between_rounds") {
    lobbySection.classList.remove("hidden");
    lobbyInfo.textContent = view.lobbyInfo;
    startRoundBtn.disabled = !view.canStartRound;
  }

  if (view.phase === "active") {
    questionSection.classList.remove("hidden");
    if (view.caseStudy) {
      caseStudy.classList.remove("hidden");
      caseStudy.textContent = view.caseStudy;
    } else {
      caseStudy.classList.add("hidden");
      caseStudy.textContent = "";
    }
    questionText.textContent = view.question;
    assignedOption.textContent = view.assignedOption;

    const selected = view.baseChoice || "";
    document.querySelectorAll("input[name='baseChoice']").forEach((input) => {
      input.checked = input.value === selected;
    });
  }

  if (view.phase === "conflict") {
    conflictSection.classList.remove("hidden");
    if (view.isConflictPlayer) {
      conflictWaiting.classList.add("hidden");
      const selected = view.conflictChoice || "";
      document.querySelectorAll("input[name='conflictChoice']").forEach((input) => {
        input.disabled = false;
        input.checked = input.value === selected;
      });
    } else {
      conflictWaiting.classList.remove("hidden");
      document.querySelectorAll("input[name='conflictChoice']").forEach((input) => {
        input.disabled = true;
        input.checked = false;
      });
    }
  }
}

async function refreshState() {
  if (!playerToken) return;
  try {
    const data = await api("getState");
    setVisibilityForJoined(true);
    renderState(data);
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function join(name) {
  const data = await api("join", { name });
  playerToken = data.playerToken;
  localStorage.setItem(tokenKey, playerToken);
  setVisibilityForJoined(true);
  showMessage("Joined successfully.", "ok");
  await refreshState();
  if (!statePoller) {
    statePoller = setInterval(refreshState, 2000);
  }
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  try {
    await join(name);
  } catch (error) {
    showMessage(error.message, "error");
  }
});

startRoundBtn.addEventListener("click", async () => {
  try {
    await api("startRound");
    showMessage("Round started.", "ok");
    await refreshState();
  } catch (error) {
    showMessage(error.message, "error");
  }
});

document.querySelectorAll("input[name='baseChoice']").forEach((input) => {
  input.addEventListener("change", async (event) => {
    const value = event.target.value;
    try {
      await api("submitBase", { confidence: value });
      showMessage("Choice saved.", "ok");
      await refreshState();
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
});

document.querySelectorAll("input[name='conflictChoice']").forEach((input) => {
  input.addEventListener("change", async (event) => {
    const value = event.target.value;
    try {
      await api("submitConflict", { actionChoice: value });
      showMessage("Conflict action saved.", "ok");
      await refreshState();
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
});

(async function init() {
  if (!playerToken) {
    setVisibilityForJoined(false);
    return;
  }

  try {
    setVisibilityForJoined(true);
    await refreshState();
    statePoller = setInterval(refreshState, 2000);
  } catch {
    localStorage.removeItem(tokenKey);
    playerToken = "";
    setVisibilityForJoined(false);
  }
})();
