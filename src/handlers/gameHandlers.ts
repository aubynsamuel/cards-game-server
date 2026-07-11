import { Server, Socket } from "socket.io";
import * as state from "../state";
import {
  PlayCardPayload,
  StartGamePayload,
  PlayerStatus,
} from "../types/ServerTypes";
import MultiplayerCardsGame from "../game/MultiplayerGameClass";
import { Callbacks, CardsGameState, GameRecord } from "../types/GameTypes";
import { updatePlayerStatus } from "./roomHandlers";
import {
  createMultiplayerGameRecord,
  saveMultiplayerGameRecord,
  saveSinglePlayerGameRecord,
} from "../services/gameRecordService";

export function startGame(
  io: Server,
  socket: Socket,
  { roomId, gameTo }: StartGamePayload
) {
  const room = state.rooms[roomId];
  if (room && room.ownerId === socket.id && room.status === "waiting") {
    if (room.players.length >= 2 && room.players.length <= 4) {
      const allPlayersReady = room.players.every(
        (player) =>
          player.status === PlayerStatus.READY || player.id === room.ownerId
      );

      if (!allPlayersReady) {
        socket.emit("start_error", {
          message: "Cannot start game until all players are ready",
        });
        return;
      }

      room.status = "playing";

      room.players.forEach((player) => {
        updatePlayerStatus(
          io,
          socket,
          roomId,
          player.id,
          PlayerStatus.IN_GAME,
          true
        );
      });

      const gamePlayers = room.players;
      const game = new MultiplayerCardsGame(gamePlayers, gameTo);
      const gameId = `game_${Date.now()}_${Math.random()
        .toString(16)
        .slice(2)}`;
      let persistenceAttempted = false;

      const callbacks: Callbacks = {
        onStateChange: (newState: CardsGameState) => {
          io.to(roomId).emit("game_state_update", newState);

          const record = createMultiplayerGameRecord(gameId, newState);
          if (!record || persistenceAttempted) return;

          persistenceAttempted = true;
          void saveMultiplayerGameRecord(record, newState)
            .then(() => {
              io.to(roomId).emit("game_record_saved", {
                gameId,
                saved: true,
              });
            })
            .catch((error: unknown) => {
              console.error("Failed to save multiplayer game record", error);
              io.to(roomId).emit("game_record_saved", {
                gameId,
                saved: false,
              });
            });
        },
        onRoundFinished: () => {},
      };

      game.setCallbacks(callbacks);
      state.gameInstances[roomId] = game;
      game.startGame();
      io.to(roomId).emit("game_started", { roomId, roomData: room, gameId });
      state.broadcastLobbyUpdate(io);
    } else {
      socket.emit("start_error", {
        message: `Incorrect number of players (${room.players.length}). Must be 2-4.`,
      });
    }
  } else if (!room) {
    socket.emit("start_error", { message: "Room does not exist." });
  } else if (room.ownerId !== socket.id) {
    socket.emit("start_error", {
      message: "Only the room owner can start the game.",
    });
  } else if (room.status !== "waiting") {
    socket.emit("start_error", {
      message: "Game cannot be started (already playing or finished).",
    });
  }
}

type SyncRecordAcknowledgement = (response: {
  ok: boolean;
  gameId?: string;
  error?: string;
}) => void;

function parseSinglePlayerRecord(
  value: unknown,
  userId: string
): GameRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<GameRecord>;
  const isValid =
    record.mode === "single-player" &&
    typeof record.gameId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(record.gameId) &&
    typeof record.dateString === "string" &&
    !Number.isNaN(Date.parse(record.dateString)) &&
    typeof record.targetScore === "number" &&
    Number.isFinite(record.targetScore) &&
    record.targetScore > 0 &&
    record.targetScore <= 1000 &&
    record.playerCount === 2 &&
    typeof record.winnerId === "string" &&
    typeof record.winnerName === "string" &&
    Array.isArray(record.players) &&
    record.players.length === 2 &&
    record.players.some((player) => player.id === userId) &&
    record.players.every(
      (player) =>
        typeof player.id === "string" &&
        typeof player.name === "string" &&
        typeof player.finalScore === "number" &&
        Number.isFinite(player.finalScore) &&
        player.finalScore >= 0 &&
        typeof player.position === "number" &&
        Number.isInteger(player.position)
    ) &&
    record.players.some((player) => player.id === record.winnerId);

  if (!isValid) return null;

  return {
    gameId: record.gameId!,
    dateString: record.dateString!,
    targetScore: record.targetScore!,
    playerCount: 2,
    mode: "single-player",
    winnerId: record.winnerId!,
    winnerName: record.winnerName!,
    players: record.players!.map((player) => ({
      id: player.id,
      name: player.name,
      finalScore: player.finalScore,
      position: player.position,
    })),
  };
}

export async function syncSinglePlayerRecord(
  socket: Socket,
  payload: { record?: unknown },
  acknowledge: SyncRecordAcknowledgement
): Promise<void> {
  const userId = socket.data.userId as string | undefined;
  if (!userId) {
    acknowledge({ ok: false, error: "Authentication required" });
    return;
  }

  const record = parseSinglePlayerRecord(payload?.record, userId);
  if (!record) {
    acknowledge({ ok: false, error: "Invalid single-player game record" });
    return;
  }

  try {
    await saveSinglePlayerGameRecord(userId, record);
    acknowledge({ ok: true, gameId: record.gameId });
  } catch (error) {
    console.error("Failed to sync single-player game record", error);
    acknowledge({ ok: false, error: "Record persistence failed" });
  }
}

export function gameEnded(
  io: Server,
  socket: Socket,
  { roomId }: { roomId: string }
) {
  const room = state.rooms[roomId];
  if (room && room.status !== "waiting") {
    room.status = "waiting";
    state.broadcastLobbyUpdate(io);

    room.players.forEach((player) => {
      const newStatus =
        player.id === room.ownerId
          ? PlayerStatus.READY
          : PlayerStatus.NOT_READY;

      updatePlayerStatus(io, socket, roomId, player.id, newStatus, true);
    });
  }
}

export function playCard(
  io: Server,
  socket: Socket,
  { roomId, card, cardIndex }: PlayCardPayload
) {
  const game = state.gameInstances[roomId];
  if (game) {
    const valid = game.playerPlayCard(socket.id, card, cardIndex);
    if (valid.error !== "" && valid.message !== "") {
      socket.emit("play_error", { valid });
    }
  } else {
    socket.emit("play_error", {
      valid: {
        error: "Error",
        message: "Game not found.",
      },
    });
  }
}
