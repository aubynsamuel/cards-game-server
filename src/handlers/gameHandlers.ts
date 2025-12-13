import { Server, Socket } from "socket.io";
import * as state from "../state";
import { PlayCardPayload, StartGamePayload, PlayerStatus } from "../types/ServerTypes";
import MultiplayerCardsGame from "../game/MultiplayerGameClass";
import { Callbacks, CardsGameState } from "../types/GameTypes";
import { updatePlayerStatus } from "./roomHandlers";

export function startGame(io: Server, socket: Socket, { roomId, gameTo }: StartGamePayload) {
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

            const callbacks: Callbacks = {
                onStateChange: (newState: CardsGameState) => {
                    io.to(roomId).emit("game_state_update", newState);
                },
                onRoundFinished: () => { },
            };

            game.setCallbacks(callbacks);
            state.gameInstances[roomId] = game;
            game.startGame();
            io.to(roomId).emit("game_started", { roomId, roomData: room });
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

export function gameEnded(io: Server, socket: Socket, { roomId }: { roomId: string }) {
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

export function playCard(io: Server, socket: Socket, { roomId, playerId, card, cardIndex }: PlayCardPayload) {
    const game = state.gameInstances[roomId];
    if (game) {
        const valid = game.playerPlayCard(playerId, card, cardIndex);
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
