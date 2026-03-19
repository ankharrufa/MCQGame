import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BASE_CHOICES = new Set(["confident_correct", "maybe_correct", "confident_incorrect"]);
const CONFLICT_CHOICES = new Set(["stand_ground", "back_down"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
    body: JSON.stringify(body),
  };
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function calcBaseScore(confidence, isCorrect) {
  if (confidence === "confident_correct") return isCorrect ? 3 : -4;
  if (confidence === "maybe_correct") return isCorrect ? 1 : 0;
  if (confidence === "confident_incorrect") return isCorrect ? -2 : 2;
  return 0;
}

function calcConflictScore(actionChoice, isCorrect) {
  if (isCorrect) return actionChoice === "stand_ground" ? 5 : 0;
  return actionChoice === "stand_ground" ? -5 : -1;
}

async function ensureRoom(roomCode) {
  const code = roomCode.trim().toLowerCase();
  let { data: room, error } = await supabase.from("game_rooms").select("*").eq("room_code", code).maybeSingle();
  if (error) throw error;

  if (!room) {
    const insertRes = await supabase
      .from("game_rooms")
      .insert({ room_code: code, status: "lobby", base_duration_seconds: 60 })
      .select("*")
      .single();
    if (insertRes.error) throw insertRes.error;
    room = insertRes.data;
  }

  if (room.base_duration_seconds !== 60) {
    const updateRes = await supabase
      .from("game_rooms")
      .update({ base_duration_seconds: 60 })
      .eq("id", room.id)
      .select("*")
      .single();
    if (updateRes.error) throw updateRes.error;
    room = updateRes.data;
  }

  return room;
}

async function getPlayerByToken(playerToken, roomId) {
  if (!playerToken) throw new Error("Missing player token.");
  const { data, error } = await supabase
    .from("players")
    .select("*")
    .eq("player_token", playerToken)
    .eq("room_id", roomId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Player not found for this room. Please rejoin.");
  return data;
}

async function reconcileRoomAdmin(roomId) {
  const playersRes = await supabase
    .from("players")
    .select("id,is_admin,join_order,created_at")
    .eq("room_id", roomId)
    .order("join_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (playersRes.error) throw playersRes.error;

  const players = playersRes.data || [];
  if (!players.length) return;

  const admins = players.filter((player) => player.is_admin === true);
  if (admins.length === 1) return;

  const primaryAdminId = (admins.length > 0 ? admins : players)[0].id;

  const setPrimary = await supabase.from("players").update({ is_admin: true }).eq("id", primaryAdminId);
  if (setPrimary.error) throw setPrimary.error;

  const removeOthers = await supabase
    .from("players")
    .update({ is_admin: false })
    .eq("room_id", roomId)
    .neq("id", primaryAdminId);
  if (removeOthers.error) throw removeOthers.error;
}

function requireAdmin(player) {
  if (!player?.is_admin) {
    throw new Error("Only the Game admin can perform this action.");
  }
}

async function syncQuestionsFromCsv() {
  const csvPath = path.join(process.cwd(), "questions.csv");
  const raw = await fs.readFile(csvPath, "utf8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const payload = [];
  const seenIds = new Set();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const rowNumber = index + 2;

    const rowValues = Object.values(record || {}).map((value) => String(value || "").trim());
    const isFullyEmpty = rowValues.every((value) => !value);
    if (isFullyEmpty) {
      continue;
    }

    const id = String(record.questionId || "").trim();
    const question = String(record.question || "").trim();
    const correctAnswer = String(record.correctAnswer || "").trim();

    if (!id) {
      throw new Error(`questions.csv row ${rowNumber}: questionId is required.`);
    }
    if (seenIds.has(id)) {
      throw new Error(`questions.csv row ${rowNumber}: duplicate questionId '${id}'.`);
    }
    if (!question) {
      throw new Error(`questions.csv row ${rowNumber}: question is required.`);
    }
    if (!correctAnswer) {
      throw new Error(`questions.csv row ${rowNumber}: correctAnswer is required.`);
    }

    seenIds.add(id);

    const pipeSeparatedIncorrect = String(record.incorrectAnswers || "")
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean);

    const extraIncorrect = Object.entries(record)
      .filter(([key]) => /^incorrectanswer\d+$/i.test(key))
      .map(([, value]) => String(value || "").trim())
      .filter(Boolean);

    const incorrect = [...new Set([...pipeSeparatedIncorrect, ...extraIncorrect])];

    payload.push({
      id,
      case_study: String(record.caseStudy || "").trim() || null,
      question,
      correct_answer: correctAnswer,
      incorrect_answers: incorrect,
    });
  }

  if (payload.length === 0) {
    throw new Error("No rows found in questions.csv");
  }

  const { error } = await supabase.from("questions").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

async function loadRoundContext(roundId) {
  const roundRes = await supabase.from("rounds").select("*").eq("id", roundId).single();
  if (roundRes.error) throw roundRes.error;

  const assignmentsRes = await supabase
    .from("round_assignments")
    .select("*")
    .eq("round_id", roundId)
    .order("created_at", { ascending: true });
  if (assignmentsRes.error) throw assignmentsRes.error;

  const baseRes = await supabase.from("base_submissions").select("*").eq("round_id", roundId);
  if (baseRes.error) throw baseRes.error;

  const conflictRes = await supabase.from("conflict_submissions").select("*").eq("round_id", roundId);
  if (conflictRes.error) throw conflictRes.error;

  return {
    round: roundRes.data,
    assignments: assignmentsRes.data,
    baseSubmissions: baseRes.data,
    conflictSubmissions: conflictRes.data,
  };
}

async function applyScoreEvents(events) {
  if (!events.length) return;

  const scoreInsert = await supabase.from("score_events").insert(events);
  if (scoreInsert.error) throw scoreInsert.error;

  const totals = new Map();
  for (const event of events) {
    totals.set(event.player_id, (totals.get(event.player_id) || 0) + event.points);
  }

  for (const [playerId, delta] of totals.entries()) {
    const playerRes = await supabase.from("players").select("score").eq("id", playerId).single();
    if (playerRes.error) throw playerRes.error;
    const updateRes = await supabase.from("players").update({ score: playerRes.data.score + delta }).eq("id", playerId);
    if (updateRes.error) throw updateRes.error;
  }
}

async function finalizeBaseOnly(room, context) {
  const baseByPlayer = new Map(context.baseSubmissions.map((submission) => [submission.player_id, submission]));
  const events = [];
  const earlyMs = new Date(context.round.early_bonus_cutoff).getTime();

  for (const assignment of context.assignments) {
    const submission = baseByPlayer.get(assignment.player_id);
    const confidence = submission?.confidence ?? "maybe_correct";
    const score = calcBaseScore(confidence, assignment.is_correct);
    events.push({
      room_id: room.id,
      round_id: context.round.id,
      player_id: assignment.player_id,
      points: score,
      reason: `base:${confidence}`,
    });

    if (
      confidence === "confident_correct" &&
      assignment.is_correct &&
      submission?.submitted_at &&
      new Date(submission.submitted_at).getTime() <= earlyMs
    ) {
      events.push({
        room_id: room.id,
        round_id: context.round.id,
        player_id: assignment.player_id,
        points: 1,
        reason: "bonus:early_confident_correct",
      });
    }
  }

  await applyScoreEvents(events);

  const roundUpdate = await supabase.from("rounds").update({ status: "completed" }).eq("id", context.round.id);
  if (roundUpdate.error) throw roundUpdate.error;

  const roomUpdate = await supabase
    .from("game_rooms")
    .update({ status: "between_rounds", current_round_id: null })
    .eq("id", room.id);
  if (roomUpdate.error) throw roomUpdate.error;
}

async function finalizeConflict(room, context) {
  const baseByPlayer = new Map(context.baseSubmissions.map((submission) => [submission.player_id, submission]));
  const conflictByPlayer = new Map(context.conflictSubmissions.map((submission) => [submission.player_id, submission]));

  const conflictPlayers = context.assignments
    .filter((assignment) => baseByPlayer.get(assignment.player_id)?.confidence === "confident_correct")
    .map((assignment) => assignment.player_id);

  const conflictSet = new Set(conflictPlayers);
  const earlyMs = new Date(context.round.early_bonus_cutoff).getTime();
  const events = [];

  const existingBaseRes = await supabase
    .from("score_events")
    .select("player_id,reason")
    .eq("round_id", context.round.id);
  if (existingBaseRes.error) throw existingBaseRes.error;
  const playersWithBaseScore = new Set(
    existingBaseRes.data.filter((item) => item.reason.startsWith("base:")).map((item) => item.player_id),
  );

  for (const assignment of context.assignments) {
    const baseSubmission = baseByPlayer.get(assignment.player_id);
    const confidence = baseSubmission?.confidence ?? "maybe_correct";

    if (!conflictSet.has(assignment.player_id)) {
      if (!playersWithBaseScore.has(assignment.player_id)) {
        events.push({
          room_id: room.id,
          round_id: context.round.id,
          player_id: assignment.player_id,
          points: calcBaseScore(confidence, assignment.is_correct),
          reason: `base:${confidence}`,
        });
      }
      continue;
    }

    const conflictAction = conflictByPlayer.get(assignment.player_id)?.action_choice ?? "back_down";
    events.push({
      room_id: room.id,
      round_id: context.round.id,
      player_id: assignment.player_id,
      points: calcConflictScore(conflictAction, assignment.is_correct),
      reason: `conflict:${conflictAction}`,
    });

    if (
      assignment.is_correct &&
      baseSubmission?.submitted_at &&
      new Date(baseSubmission.submitted_at).getTime() <= earlyMs
    ) {
      events.push({
        room_id: room.id,
        round_id: context.round.id,
        player_id: assignment.player_id,
        points: 1,
        reason: "bonus:early_confident_correct",
      });
    }
  }

  await applyScoreEvents(events);

  const roundUpdate = await supabase.from("rounds").update({ status: "completed" }).eq("id", context.round.id);
  if (roundUpdate.error) throw roundUpdate.error;

  const roomUpdate = await supabase
    .from("game_rooms")
    .update({ status: "between_rounds", current_round_id: null })
    .eq("id", room.id);
  if (roomUpdate.error) throw roomUpdate.error;
}

async function awardNonConflictBaseScoresAtConflictStart(room, context) {
  const baseByPlayer = new Map(context.baseSubmissions.map((submission) => [submission.player_id, submission]));
  const conflictSet = new Set(
    context.assignments
      .filter((assignment) => baseByPlayer.get(assignment.player_id)?.confidence === "confident_correct")
      .map((assignment) => assignment.player_id),
  );

  const nonConflictAssignments = context.assignments.filter((assignment) => !conflictSet.has(assignment.player_id));
  if (!nonConflictAssignments.length) return;

  const nonConflictPlayerIds = nonConflictAssignments.map((assignment) => assignment.player_id);
  const existingRes = await supabase
    .from("score_events")
    .select("player_id,reason")
    .eq("round_id", context.round.id)
    .in("player_id", nonConflictPlayerIds);
  if (existingRes.error) throw existingRes.error;

  const alreadyScored = new Set(
    existingRes.data.filter((item) => item.reason.startsWith("base:")).map((item) => item.player_id),
  );

  const events = [];
  for (const assignment of nonConflictAssignments) {
    if (alreadyScored.has(assignment.player_id)) continue;
    const confidence = baseByPlayer.get(assignment.player_id)?.confidence ?? "maybe_correct";
    events.push({
      room_id: room.id,
      round_id: context.round.id,
      player_id: assignment.player_id,
      points: calcBaseScore(confidence, assignment.is_correct),
      reason: `base:${confidence}`,
    });
  }

  await applyScoreEvents(events);
}

async function advanceGameIfNeeded(room) {
  if (!room.current_round_id) return;

  const context = await loadRoundContext(room.current_round_id);
  const now = Date.now();

  if (context.round.status === "active") {
    const allSubmitted = context.baseSubmissions.length >= context.assignments.length;
    const expired = new Date(context.round.base_deadline).getTime() <= now;
    if (!allSubmitted && !expired) return;

    const baseByPlayer = new Map(context.baseSubmissions.map((submission) => [submission.player_id, submission]));
    const conflictClaimants = context.assignments.filter(
      (assignment) => baseByPlayer.get(assignment.player_id)?.confidence === "confident_correct",
    );

    if (conflictClaimants.length >= 2) {
      await awardNonConflictBaseScoresAtConflictStart(room, context);

      const conflictDeadline = new Date(now + room.conflict_duration_seconds * 1000).toISOString();
      const updateRound = await supabase
        .from("rounds")
        .update({ status: "conflict", conflict_deadline: conflictDeadline })
        .eq("id", context.round.id);
      if (updateRound.error) throw updateRound.error;

      const roomUpdate = await supabase.from("game_rooms").update({ status: "conflict" }).eq("id", room.id);
      if (roomUpdate.error) throw roomUpdate.error;
      return;
    }

    await finalizeBaseOnly(room, context);
    return;
  }

  if (context.round.status === "conflict") {
    const baseByPlayer = new Map(context.baseSubmissions.map((submission) => [submission.player_id, submission]));
    const conflictPlayers = context.assignments.filter(
      (assignment) => baseByPlayer.get(assignment.player_id)?.confidence === "confident_correct",
    );
    const allSubmitted = context.conflictSubmissions.length >= conflictPlayers.length;
    const expired = new Date(context.round.conflict_deadline).getTime() <= now;
    if (!allSubmitted && !expired) return;

    await finalizeConflict(room, context);
  }
}

async function getLeaderboard(roomId) {
  const playersRes = await supabase
    .from("players")
    .select("id,name,score")
    .eq("room_id", roomId)
    .order("score", { ascending: false })
    .order("created_at", { ascending: true });
  if (playersRes.error) throw playersRes.error;
  return playersRes.data;
}

async function buildPlayerView(room, player) {
  const leaderboard = await getLeaderboard(room.id);

  if (!room.current_round_id) {
    const questionsRes = await supabase.from("questions").select("id,incorrect_answers");
    if (questionsRes.error) throw questionsRes.error;

    const playersRes = await supabase.from("players").select("id").eq("room_id", room.id);
    if (playersRes.error) throw playersRes.error;

    const playerCount = playersRes.data.length;
    const hasMatchingQuestion = questionsRes.data.some(
      (question) => (question.incorrect_answers?.length || 0) + 1 === playerCount,
    );

    return {
      leaderboard,
      view: {
        phase: room.status === "between_rounds" ? "between_rounds" : "lobby",
        phaseLabel: room.status === "between_rounds" ? "Round Complete" : "Lobby",
        statusMessage: room.status === "between_rounds" ? "Start the next round when ready." : "Waiting for players.",
        lobbyInfo: hasMatchingQuestion
          ? `Players joined: ${playerCount}. A matching question is available.`
          : `Players joined: ${playerCount}. If start fails, add a CSV question with exactly ${playerCount} options (1 correct + ${Math.max(0, playerCount - 1)} incorrect).`,
        canStartRound: playerCount >= 2,
      },
    };
  }

  const context = await loadRoundContext(room.current_round_id);
  const questionRes = await supabase
    .from("questions")
    .select("id,case_study,question,correct_answer")
    .eq("id", context.round.question_id)
    .single();
  if (questionRes.error) throw questionRes.error;

  const assignment = context.assignments.find((item) => item.player_id === player.id);
  const baseSubmission = context.baseSubmissions.find((item) => item.player_id === player.id);
  const conflictSubmission = context.conflictSubmissions.find((item) => item.player_id === player.id);

  if (context.round.status === "active") {
    const participatingPlayerIds = context.assignments.map((item) => item.player_id);
    const allRoomPlayersRes = await supabase.from("players").select("id").eq("room_id", room.id);
    if (allRoomPlayersRes.error) throw allRoomPlayersRes.error;
    const inactivePlayerIds = (allRoomPlayersRes.data || [])
      .map((item) => item.id)
      .filter((playerId) => !participatingPlayerIds.includes(playerId));

    if (!assignment) {
      const participantCount = context.assignments.length;
      return {
        leaderboard,
        view: {
          phase: "active",
          phaseLabel: `Round ${room.round_number}`,
          statusMessage: `This round has ${participantCount} options, so only the first ${participantCount} joined players are participating.`,
          deadline: context.round.base_deadline,
          roundId: context.round.id,
          inactivePlayerIds,
          isParticipant: false,
        },
      };
    }

    return {
      leaderboard,
      view: {
        phase: "active",
        phaseLabel: `Round ${room.round_number}`,
        statusMessage: "Submit your confidence level before the timer ends.",
        deadline: context.round.base_deadline,
        roundId: context.round.id,
        inactivePlayerIds,
        isParticipant: true,
        caseStudy: questionRes.data.case_study,
        question: questionRes.data.question,
        assignedOption: assignment.option_text,
        baseChoice: baseSubmission?.confidence ?? null,
      },
    };
  }

  if (context.round.status === "conflict") {
    const conflictPlayers = context.assignments
      .filter((item) => context.baseSubmissions.find((base) => base.player_id === item.player_id)?.confidence === "confident_correct")
      .map((item) => item.player_id);
    const isConflictPlayer = conflictPlayers.includes(player.id);

    const challengeNamesRes = conflictPlayers.length
      ? await supabase.from("players").select("id,name").in("id", conflictPlayers)
      : { data: [], error: null };
    if (challengeNamesRes.error) throw challengeNamesRes.error;
    const challengePlayers = (challengeNamesRes.data || []).map((item) => item.name);

    const lockedScoreRes = await supabase
      .from("score_events")
      .select("points")
      .eq("round_id", context.round.id)
      .eq("player_id", player.id);
    if (lockedScoreRes.error) throw lockedScoreRes.error;
    const lockedRoundScore = (lockedScoreRes.data || []).reduce((sum, item) => sum + item.points, 0);

    return {
      leaderboard,
      view: {
        phase: "conflict",
        phaseLabel: `Round ${room.round_number} Challenge Phase`,
        statusMessage: "Challenge in progress.",
        deadline: context.round.conflict_deadline,
        isConflictPlayer,
        challengePlayers,
        lockedRoundScore,
        conflictChoice: conflictSubmission?.action_choice ?? null,
      },
    };
  }

  return {
    leaderboard,
    view: {
      phase: "between_rounds",
      phaseLabel: "Round Complete",
      statusMessage: "Start next round.",
      lobbyInfo: "Round finished.",
      canStartRound: true,
    },
  };
}

async function actionJoin(room, payload) {
  const name = (payload?.name || "").trim();
  const isAdminRequested = Boolean(payload?.isAdmin);
  if (!name) throw new Error("Name is required.");

  const duplicateRes = await supabase
    .from("players")
    .select("id")
    .eq("room_id", room.id)
    .ilike("name", name)
    .maybeSingle();

  if (duplicateRes.error) throw duplicateRes.error;
  if (duplicateRes.data) throw new Error("That name is already taken in this room.");

  const countRes = await supabase.from("players").select("id", { count: "exact", head: true }).eq("room_id", room.id);
  if (countRes.error) throw countRes.error;

  await reconcileRoomAdmin(room.id);
  const adminRes = await supabase
    .from("players")
    .select("id")
    .eq("room_id", room.id)
    .eq("is_admin", true)
    .limit(1);
  if (adminRes.error) throw adminRes.error;

  const hasAdmin = (adminRes.data || []).length > 0;
  const isFirstPlayer = (countRes.count || 0) === 0;

  let isAdmin = false;
  if (isAdminRequested) {
    if (hasAdmin) {
      throw new Error("A Game admin is already assigned for this room.");
    }
    isAdmin = true;
  } else if (!hasAdmin && isFirstPlayer) {
    isAdmin = true;
  }

  const token = randomUUID();
  const insertRes = await supabase
    .from("players")
    .insert({
      room_id: room.id,
      name,
      join_order: (countRes.count || 0) + 1,
      player_token: token,
      is_admin: isAdmin,
    })
    .select("id")
    .single();

  if (insertRes.error) throw insertRes.error;
  return { playerToken: token };
}

async function actionStartRound(room, player) {
  await syncQuestionsFromCsv();
  await advanceGameIfNeeded(room);

  const freshRoomRes = await supabase.from("game_rooms").select("*").eq("id", room.id).single();
  if (freshRoomRes.error) throw freshRoomRes.error;
  const freshRoom = freshRoomRes.data;

  if (freshRoom.current_round_id) {
    throw new Error("A round is already active.");
  }

  const playersRes = await supabase.from("players").select("id,name,join_order").eq("room_id", room.id).order("join_order", { ascending: true });
  if (playersRes.error) throw playersRes.error;

  const players = playersRes.data;
  if (players.length < 2) {
    throw new Error("At least 2 players are required to start.");
  }

  const questionsRes = await supabase.from("questions").select("*");
  if (questionsRes.error) throw questionsRes.error;

  const usedRes = await supabase.from("rounds").select("question_id").eq("room_id", room.id);
  if (usedRes.error) throw usedRes.error;
  const usedIds = new Set(usedRes.data.map((item) => item.question_id));

  const candidates = questionsRes.data.filter((question) => {
    const optionCount = (question.incorrect_answers?.length || 0) + 1;
    return optionCount <= players.length && optionCount >= 2 && !usedIds.has(question.id);
  });

  if (candidates.length === 0) {
    throw new Error(
      `No available question has options less than or equal to ${players.length}. Update questions.csv or reset rounds for this room.`,
    );
  }

  const exactCandidates = candidates.filter((question) => ((question.incorrect_answers?.length || 0) + 1) === players.length);
  const pool = exactCandidates.length
    ? exactCandidates
    : candidates.filter((question) => {
        const optionCount = (question.incorrect_answers?.length || 0) + 1;
        const maxOptionCount = Math.max(...candidates.map((q) => (q.incorrect_answers?.length || 0) + 1));
        return optionCount === maxOptionCount;
      });

  const picked = pool[Math.floor(Math.random() * pool.length)];
  const options = shuffle([picked.correct_answer, ...(picked.incorrect_answers || [])]);
  const participantCount = options.length;
  const participatingPlayers = players.slice(0, participantCount);
  const shuffledPlayers = shuffle(participatingPlayers);

  const now = Date.now();
  const baseDurationSeconds = 60;
  const baseDeadline = new Date(now + baseDurationSeconds * 1000).toISOString();
  const earlyBonusCutoff = new Date(now + Math.floor(baseDurationSeconds * 0.4) * 1000).toISOString();

  const roundInsert = await supabase
    .from("rounds")
    .insert({
      room_id: room.id,
      question_id: picked.id,
      status: "active",
      started_at: new Date(now).toISOString(),
      base_deadline: baseDeadline,
      early_bonus_cutoff: earlyBonusCutoff,
    })
    .select("*")
    .single();
  if (roundInsert.error) throw roundInsert.error;

  const assignments = shuffledPlayers.map((roundPlayer, index) => ({
    round_id: roundInsert.data.id,
    player_id: roundPlayer.id,
    option_text: options[index],
    is_correct: options[index] === picked.correct_answer,
  }));

  const assignRes = await supabase.from("round_assignments").insert(assignments);
  if (assignRes.error) throw assignRes.error;

  const roomUpdate = await supabase
    .from("game_rooms")
    .update({
      status: "active",
      current_round_id: roundInsert.data.id,
      round_number: freshRoom.round_number + 1,
      last_started_by_player_id: player.id,
    })
    .eq("id", room.id);

  if (roomUpdate.error) throw roomUpdate.error;
}

async function actionSubmitBase(room, player, payload) {
  if (!room.current_round_id) throw new Error("No active round.");
  const confidence = payload?.confidence;
  if (!BASE_CHOICES.has(confidence)) throw new Error("Invalid base choice.");

  const context = await loadRoundContext(room.current_round_id);
  if (context.round.status !== "active") throw new Error("Round is not in active phase.");

  const exists = context.assignments.some((item) => item.player_id === player.id);
  if (!exists) throw new Error("You are not assigned in this round.");

  const upsertRes = await supabase.from("base_submissions").upsert(
    {
      round_id: room.current_round_id,
      player_id: player.id,
      confidence,
      submitted_at: new Date().toISOString(),
    },
    { onConflict: "round_id,player_id" },
  );
  if (upsertRes.error) throw upsertRes.error;

  await advanceGameIfNeeded(room);
}

async function actionSubmitConflict(room, player, payload) {
  if (!room.current_round_id) throw new Error("No round in progress.");
  const actionChoice = payload?.actionChoice;
  if (!CONFLICT_CHOICES.has(actionChoice)) throw new Error("Invalid conflict choice.");

  const context = await loadRoundContext(room.current_round_id);
  if (context.round.status !== "conflict") throw new Error("Round is not in conflict phase.");

  const baseByPlayer = new Map(context.baseSubmissions.map((item) => [item.player_id, item]));
  const isConflictPlayer = context.assignments.some(
    (assignment) => assignment.player_id === player.id && baseByPlayer.get(player.id)?.confidence === "confident_correct",
  );

  if (!isConflictPlayer) throw new Error("Only conflict players can submit conflict action.");

  const upsertRes = await supabase.from("conflict_submissions").upsert(
    {
      round_id: room.current_round_id,
      player_id: player.id,
      action_choice: actionChoice,
      submitted_at: new Date().toISOString(),
    },
    { onConflict: "round_id,player_id" },
  );
  if (upsertRes.error) throw upsertRes.error;

  await advanceGameIfNeeded(room);
}

async function actionResetRounds(room) {
  const roundsRes = await supabase.from("rounds").select("id").eq("room_id", room.id);
  if (roundsRes.error) throw roundsRes.error;

  const roundIds = roundsRes.data.map((item) => item.id);

  const scoreDelete = await supabase.from("score_events").delete().eq("room_id", room.id);
  if (scoreDelete.error) throw scoreDelete.error;

  if (roundIds.length > 0) {
    const conflictDelete = await supabase.from("conflict_submissions").delete().in("round_id", roundIds);
    if (conflictDelete.error) throw conflictDelete.error;

    const baseDelete = await supabase.from("base_submissions").delete().in("round_id", roundIds);
    if (baseDelete.error) throw baseDelete.error;

    const assignmentDelete = await supabase.from("round_assignments").delete().in("round_id", roundIds);
    if (assignmentDelete.error) throw assignmentDelete.error;

    const roundDelete = await supabase.from("rounds").delete().eq("room_id", room.id);
    if (roundDelete.error) throw roundDelete.error;
  }

  const playerReset = await supabase.from("players").update({ score: 0 }).eq("room_id", room.id);
  if (playerReset.error) throw playerReset.error;

  const roomReset = await supabase
    .from("game_rooms")
    .update({ status: "lobby", current_round_id: null, round_number: 0 })
    .eq("id", room.id);
  if (roomReset.error) throw roomReset.error;
}

async function actionResetPlayers(room, player) {
  await actionResetRounds(room);

  const deleteOthers = await supabase.from("players").delete().eq("room_id", room.id).neq("id", player.id);
  if (deleteOthers.error) throw deleteOthers.error;

  const keepAdmin = await supabase
    .from("players")
    .update({ score: 0, join_order: 1, is_admin: true })
    .eq("id", player.id);
  if (keepAdmin.error) throw keepAdmin.error;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const action = body.action;
    const roomCode = (body.roomCode || "main").trim();
    const payload = body.payload || {};
    const playerToken = body.playerToken || "";

    if (!action) {
      return json(400, { ok: false, error: "Missing action." });
    }

    const room = await ensureRoom(roomCode);

    if (action === "join") {
      const result = await actionJoin(room, payload);
      return json(200, { ok: true, ...result });
    }

    await reconcileRoomAdmin(room.id);
    const player = await getPlayerByToken(playerToken, room.id);
    await advanceGameIfNeeded(room);

    if (action === "startRound") {
      await actionStartRound(room, player);
    } else if (action === "resetRounds" || action === "restartGame") {
      requireAdmin(player);
      await actionResetRounds(room);
    } else if (action === "resetPlayers") {
      requireAdmin(player);
      await actionResetPlayers(room, player);
    } else if (action === "submitBase") {
      await actionSubmitBase(room, player, payload);
    } else if (action === "submitConflict") {
      await actionSubmitConflict(room, player, payload);
    } else if (action !== "getState") {
      throw new Error("Unsupported action.");
    }

    const freshRoomRes = await supabase.from("game_rooms").select("*").eq("id", room.id).single();
    if (freshRoomRes.error) throw freshRoomRes.error;

    const output = await buildPlayerView(freshRoomRes.data, player);
    return json(200, { ok: true, playerName: player.name, isAdmin: !!player.is_admin, ...output });
  } catch (error) {
    return json(400, { ok: false, error: error.message || "Unexpected error." });
  }
};
