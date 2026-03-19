const roomCode = new URLSearchParams(window.location.search).get("room") || "main";
const tokenKey = `hoc_player_token_${roomCode}`;
const nameKey = `hoc_player_name_${roomCode}`;
let playerToken = localStorage.getItem(tokenKey) || "";
let lastKnownName = localStorage.getItem(nameKey) || "";
let statePoller = null;
let pendingBaseChoice = null;
let pendingConflictChoice = null;
let stateRequestSeq = 0;
let latestAppliedStateSeq = 0;
let currentRoundId = null;
let startRoundInFlight = false;

const roomCodeLabel = document.getElementById("roomCodeLabel");
const playerNameLabel = document.getElementById("playerNameLabel");
const joinCard = document.getElementById("joinCard");
const gameCard = document.getElementById("gameCard");
const leaderboardCard = document.getElementById("leaderboardCard");
const joinForm = document.getElementById("joinForm");
const nameInput = document.getElementById("nameInput");
const adminCheckbox = document.getElementById("adminCheckbox");
const messageEl = document.getElementById("message");
const rejoinBtn = document.getElementById("rejoinBtn");
const scoringRulesBtn = document.getElementById("scoringRulesBtn");
const scoringModal = document.getElementById("scoringModal");
const closeScoringModalBtn = document.getElementById("closeScoringModalBtn");

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
const roundSummarySection = document.getElementById("roundSummarySection");
const roundScoreLine = document.getElementById("roundScoreLine");
const roundCaseStudy = document.getElementById("roundCaseStudy");
const roundQuestionText = document.getElementById("roundQuestionText");
const roundOptionsList = document.getElementById("roundOptionsList");

const leaderboardBody = document.getElementById("leaderboardBody");

roomCodeLabel.textContent = roomCode;
if (lastKnownName) {
  nameInput.value = lastKnownName;
}

function showMessage(text, kind = "") {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`.trim();
}

function openScoringModal() {
  scoringModal.classList.remove("hidden");
}

function closeScoringModal() {
  scoringModal.classList.add("hidden");
}

function showRejoinOption(visible) {
  rejoinBtn.classList.toggle("hidden", !visible);
}

function handlePlayerSessionExpired(errorMessage) {
  localStorage.removeItem(tokenKey);
  playerToken = "";
  setVisibilityForJoined(false);
  if (statePoller) {
    clearInterval(statePoller);
    statePoller = null;
  }
  if (lastKnownName && !nameInput.value.trim()) {
    nameInput.value = lastKnownName;
  }
  showMessage(errorMessage, "error");
  showRejoinOption(true);
}

function clearAllSelections() {
  pendingBaseChoice = null;
  pendingConflictChoice = null;
  document.querySelectorAll("input[name='baseChoice']").forEach((input) => {
    input.checked = false;
  });
  document.querySelectorAll("input[name='conflictChoice']").forEach((input) => {
    input.checked = false;
  });
}

function setStartRoundLoading(loading) {
  startRoundInFlight = loading;
  startRoundBtn.disabled = loading;
  startRoundBtn.classList.toggle("loading", loading);
  startRoundBtn.textContent = loading ? "Starting..." : "Start Next Round";
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

function renderLeaderboard(players, view) {
  const inactiveIds = new Set(view?.phase === "active" ? (view?.inactivePlayerIds || []) : []);
  leaderboardBody.innerHTML = "";
  players.forEach((player, index) => {
    const row = document.createElement("tr");
    const inactiveTag = inactiveIds.has(player.id) ? " (inactive)" : "";
    row.innerHTML = `<td>${index + 1}</td><td>${player.name}${inactiveTag}</td><td>${player.score}</td>`;
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
  roundSummarySection.classList.add("hidden");
}

function renderRoundSummary(summary) {
  if (!summary) {
    roundSummarySection.classList.add("hidden");
    roundCaseStudy.classList.add("hidden");
    roundCaseStudy.textContent = "";
    roundQuestionText.textContent = "";
    roundOptionsList.innerHTML = "";
    return;
  }

  roundSummarySection.classList.remove("hidden");
  const scoreSign = summary.roundScore > 0 ? "+" : "";
  const breakdown = Array.isArray(summary.scoreBreakdown) ? summary.scoreBreakdown : [];
  const explanation = buildRoundScoreExplanation(breakdown);
  roundScoreLine.textContent = `Your score this round: ${scoreSign}${summary.roundScore}${explanation ? ` — ${explanation}` : ""}`;

  if (summary.caseStudy) {
    roundCaseStudy.classList.remove("hidden");
    roundCaseStudy.textContent = summary.caseStudy;
  } else {
    roundCaseStudy.classList.add("hidden");
    roundCaseStudy.textContent = "";
  }

  roundQuestionText.textContent = summary.question || "";

  roundOptionsList.innerHTML = "";

  for (const option of summary.options || []) {
    const item = document.createElement("li");
    item.className = "round-option";
    if (option.isChosen) item.classList.add("chosen");
    if (option.isCorrect) item.classList.add("correct");

    const tags = [];
    if (option.isChosen) tags.push("your choice");
    if (option.isCorrect) tags.push("correct");
    const tagSuffix = tags.length ? `<span class=\"round-option-tags\">(${tags.join(" • ")})</span>` : "";
    item.innerHTML = `<span>${option.text}</span>${tagSuffix}`;
    roundOptionsList.appendChild(item);
  }
}

function buildRoundScoreExplanation(scoreBreakdown) {
  if (!scoreBreakdown.length) {
    return "No scoring event this round (likely inactive).";
  }

  const reasonToText = {
    "base:confident_correct": "base rule: Confident Correct",
    "base:maybe_correct": "base rule: Maybe Correct",
    "base:confident_incorrect": "base rule: Confident Incorrect",
    "conflict:stand_ground": "challenge rule: Stand Ground",
    "conflict:back_down": "challenge rule: Back Down",
  };

  const pieces = scoreBreakdown.map((event) => {
    const label = reasonToText[event.reason] || event.reason;
    const points = Number(event.points || 0);
    const signed = points > 0 ? `+${points}` : `${points}`;
    return `${label} (${signed})`;
  });

  return pieces.join("; ");
}

function renderState(data) {
  const { view, leaderboard } = data;

  if (view.roundId && view.roundId !== currentRoundId) {
    currentRoundId = view.roundId;
    clearAllSelections();
  }

  if (!view.roundId) {
    currentRoundId = null;
    clearAllSelections();
  }

  if (data.playerName) {
    playerNameLabel.textContent = data.playerName;
  }
  renderLeaderboard(leaderboard || [], view);
  clearSections();
  renderTimer(view.deadline || null);

  phaseTitle.textContent = view.phaseLabel;
  statusLine.textContent = view.statusMessage || "";

  if (view.phase === "lobby" || view.phase === "between_rounds") {
    lobbySection.classList.remove("hidden");
    lobbyInfo.textContent = view.lobbyInfo;
    startRoundBtn.classList.toggle("hidden", !data.isAdmin);
    startRoundBtn.disabled = startRoundInFlight || !view.canStartRound;
    adminControls.classList.toggle("hidden", !data.isAdmin);
    renderRoundSummary(view.roundSummary || null);
  } else {
    startRoundBtn.classList.add("hidden");
    renderRoundSummary(null);
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
    const selected = pendingBaseChoice ?? view.baseChoice ?? "";
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
    showRejoinOption(false);
  } catch (error) {
    if (error.message === "Player not found for this room. Please rejoin.") {
      handlePlayerSessionExpired(error.message);
      return;
    }
    showMessage(error.message, "error");
  }
}

async function join(name) {
  const wantsAdmin = Boolean(adminCheckbox?.checked);
  const data = await api("join", { name, isAdmin: wantsAdmin });
  playerToken = data.playerToken;
  lastKnownName = name;
  localStorage.setItem(tokenKey, playerToken);
  localStorage.setItem(nameKey, lastKnownName);
  setVisibilityForJoined(true);
  showRejoinOption(false);
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
  showRejoinOption(false);
  try {
    await join(name);
  } catch (error) {
    showMessage(error.message, "error");
  }
});

startRoundBtn.addEventListener("click", async () => {
  if (startRoundInFlight) return;
  try {
    clearAllSelections();
    setStartRoundLoading(true);
    await api("startRound");
    showMessage("Round started.", "ok");
    await refreshState();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setStartRoundLoading(false);
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

rejoinBtn.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  if (!name) {
    showMessage("Enter your name, then click Rejoin.", "error");
    nameInput.focus();
    return;
  }

  try {
    await join(name);
  } catch (error) {
    showMessage(error.message, "error");
  }
});

scoringRulesBtn.addEventListener("click", () => {
  openScoringModal();
});

closeScoringModalBtn.addEventListener("click", () => {
  closeScoringModal();
});

scoringModal.addEventListener("click", (event) => {
  if (event.target === scoringModal) {
    closeScoringModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !scoringModal.classList.contains("hidden")) {
    closeScoringModal();
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
