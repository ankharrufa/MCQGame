const roomCode = new URLSearchParams(window.location.search).get("room") || "main";
const tokenKey = `hoc_player_token_${roomCode}`;
let playerToken = localStorage.getItem(tokenKey) || "";
let statePoller = null;
let pendingBaseChoice = null;
let pendingConflictChoice = null;
let stateRequestSeq = 0;
let latestAppliedStateSeq = 0;

const roomCodeLabel = document.getElementById("roomCodeLabel");
const playerNameLabel = document.getElementById("playerNameLabel");
const joinCard = document.getElementById("joinCard");
const gameCard = document.getElementById("gameCard");
const leaderboardCard = document.getElementById("leaderboardCard");
const joinForm = document.getElementById("joinForm");
const nameInput = document.getElementById("nameInput");
const adminCheckbox = document.getElementById("adminCheckbox");
const messageEl = document.getElementById("message");

const phaseTitle = document.getElementById("phaseTitle");
const statusLine = document.getElementById("statusLine");
const timerEl = document.getElementById("timer");

const lobbySection = document.getElementById("lobbySection");
const lobbyInfo = document.getElementById("lobbyInfo");
const startRoundBtn = document.getElementById("startRoundBtn");
const adminControls = document.getElementById("adminControls");
const resetRoundsBtn = document.getElementById("resetRoundsBtn");
const resetPlayersBtn = document.getElementById("resetPlayersBtn");

const questionSection = document.getElementById("questionSection");
const caseStudy = document.getElementById("caseStudy");
const questionText = document.getElementById("questionText");
const assignedOption = document.getElementById("assignedOption");
const baseChoices = document.getElementById("baseChoices");

const conflictSection = document.getElementById("conflictSection");
const conflictPrompt = document.getElementById("conflictPrompt");
const conflictChoices = document.getElementById("conflictChoices");
const conflictWaiting = document.getElementById("conflictWaiting");

const leaderboardBody = document.getElementById("leaderboardBody");

roomCodeLabel.textContent = roomCode;

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
    timerEl.classList.remove("urgent");
    return;
  }
  timerEl.classList.remove("hidden");
  const seconds = Math.max(0, Math.ceil((new Date(deadlineIso).getTime() - Date.now()) / 1000));
  timerEl.textContent = `${seconds}s`;
  timerEl.classList.toggle("urgent", seconds <= 10);
}

function clearSections() {
  lobbySection.classList.add("hidden");
  questionSection.classList.add("hidden");
  conflictSection.classList.add("hidden");
}

function renderState(data) {
  const { view, leaderboard } = data;
  if (data.playerName) {
    playerNameLabel.textContent = data.playerName;
  }
  renderLeaderboard(leaderboard || []);
  clearSections();
  renderTimer(view.deadline || null);

  phaseTitle.textContent = view.phaseLabel;
  statusLine.textContent = view.statusMessage || "";

  if (view.phase === "lobby" || view.phase === "between_rounds") {
    lobbySection.classList.remove("hidden");
    lobbyInfo.textContent = view.lobbyInfo;
    startRoundBtn.disabled = !view.canStartRound;
    adminControls.classList.toggle("hidden", !data.isAdmin);
  }

  if (view.phase === "active") {
    questionSection.classList.remove("hidden");
    const isParticipant = view.isParticipant !== false;

    if (!isParticipant) {
      caseStudy.classList.add("hidden");
      caseStudy.textContent = "";
      questionText.textContent = "You are waiting this round because there are more players than available options.";
      assignedOption.textContent = "Not assigned this round";
      baseChoices.classList.add("hidden");
      document.querySelectorAll("input[name='baseChoice']").forEach((input) => {
        input.checked = false;
      });
      pendingBaseChoice = null;
      return;
    }

    baseChoices.classList.remove("hidden");
    if (view.caseStudy) {
      caseStudy.classList.remove("hidden");
      caseStudy.textContent = view.caseStudy;
    } else {
      caseStudy.classList.add("hidden");
      caseStudy.textContent = "";
    }
    questionText.textContent = view.question;
    assignedOption.textContent = view.assignedOption;

    if (pendingBaseChoice && view.baseChoice === pendingBaseChoice) {
      pendingBaseChoice = null;
    }
    const currentSelectedInput = document.querySelector("input[name='baseChoice']:checked");
    const currentSelectedValue = currentSelectedInput ? currentSelectedInput.value : "";
    const selected = pendingBaseChoice ?? view.baseChoice ?? currentSelectedValue;
    document.querySelectorAll("input[name='baseChoice']").forEach((input) => {
      input.checked = input.value === selected;
    });
  } else {
    pendingBaseChoice = null;
  }

  if (view.phase === "conflict") {
    conflictSection.classList.remove("hidden");
    const challengePlayers = Array.isArray(view.challengePlayers) ? view.challengePlayers : [];
    const challengeLabel = challengePlayers.length ? challengePlayers.join(", ") : "Multiple players";
    if (view.isConflictPlayer) {
      conflictChoices.classList.remove("hidden");
      conflictPrompt.textContent = `Challenge Phase: ${challengeLabel} claimed they are correct. Choose your action.`;
      conflictWaiting.classList.add("hidden");
      if (pendingConflictChoice && view.conflictChoice === pendingConflictChoice) {
        pendingConflictChoice = null;
      }
      const selected = pendingConflictChoice ?? view.conflictChoice ?? "";
      document.querySelectorAll("input[name='conflictChoice']").forEach((input) => {
        input.disabled = false;
        input.checked = input.value === selected;
      });
    } else {
      conflictChoices.classList.add("hidden");
      conflictPrompt.textContent = `Challenge Phase: ${challengeLabel} are resolving the final claim.`;
      conflictWaiting.classList.remove("hidden");
      const lockedScore = Number.isFinite(view.lockedRoundScore) ? view.lockedRoundScore : 0;
      conflictWaiting.textContent = `Your score for this round is locked at ${lockedScore}. Waiting for challenge results.`;
      document.querySelectorAll("input[name='conflictChoice']").forEach((input) => {
        input.disabled = true;
        input.checked = false;
      });
    }
  } else {
    conflictChoices.classList.remove("hidden");
    pendingConflictChoice = null;
  }
}

async function refreshState() {
  if (!playerToken) return;
  const requestSeq = ++stateRequestSeq;
  try {
    const data = await api("getState");
    if (requestSeq < latestAppliedStateSeq) {
      return;
    }
    latestAppliedStateSeq = requestSeq;
    setVisibilityForJoined(true);
    renderState(data);
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function join(name) {
  const wantsAdmin = Boolean(adminCheckbox?.checked);
  const data = await api("join", { name, isAdmin: wantsAdmin });
  playerToken = data.playerToken;
  localStorage.setItem(tokenKey, playerToken);
  setVisibilityForJoined(true);
  showMessage(wantsAdmin ? "Joined successfully. Admin request submitted." : "Joined successfully.", "ok");
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

resetRoundsBtn.addEventListener("click", async () => {
  const confirmed = window.confirm("Reset rounds? This clears rounds and scores, but keeps all joined players.");
  if (!confirmed) return;

  try {
    await api("resetRounds");
    showMessage("Rounds reset.", "ok");
    pendingBaseChoice = null;
    pendingConflictChoice = null;
    await refreshState();
  } catch (error) {
    showMessage(error.message, "error");
  }
});

resetPlayersBtn.addEventListener("click", async () => {
  const confirmed = window.confirm("Reset players? This removes all other players and keeps only you as Game admin.");
  if (!confirmed) return;

  try {
    await api("resetPlayers");
    showMessage("Players reset. You remain as Game admin.", "ok");
    pendingBaseChoice = null;
    pendingConflictChoice = null;
    await refreshState();
  } catch (error) {
    showMessage(error.message, "error");
  }
});

document.querySelectorAll("input[name='baseChoice']").forEach((input) => {
  input.addEventListener("change", async (event) => {
    const value = event.target.value;
    pendingBaseChoice = value;
    try {
      await api("submitBase", { confidence: value });
      showMessage("Choice saved.", "ok");
      await refreshState();
    } catch (error) {
      pendingBaseChoice = null;
      showMessage(error.message, "error");
    }
  });
});

document.querySelectorAll("input[name='conflictChoice']").forEach((input) => {
  input.addEventListener("change", async (event) => {
    const value = event.target.value;
    pendingConflictChoice = value;
    try {
      await api("submitConflict", { actionChoice: value });
      showMessage("Conflict action saved.", "ok");
      await refreshState();
    } catch (error) {
      pendingConflictChoice = null;
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
