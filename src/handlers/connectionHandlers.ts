import { Server, Socket } from "socket.io";
import * as state from "../state";
import { PlayerStatus } from "../types/ServerTypes";

function sendReconnectionResponse(
  socket: Socket,
  status: "success" | "failed",
  message: string
) {
  setTimeout(() => {
    socket.emit("reconnection_response", { status, message });
  }, 2000);
};

export function handleDisconnect(
  io: Server,
  socket: Socket,
  isIntentional: boolean = false
): void {
  // console.log("User disconnected:", socket.id);
  const roomId = state.socketRoomMap[socket.id];
  if (roomId && state.rooms[roomId]) {
    const room = state.rooms[roomId];
    const playerIndex = room.players.findIndex((p) => p.id === socket.id);

    if (playerIndex !== -1) {
      const leavingPlayer = room.players.splice(playerIndex, 1)[0];

      delete state.socketRoomMap[socket.id];

      const game = state.gameInstances[roomId];
      if (game) {
        const gamePlayerIndex = game.players.findIndex(
          (p) => p.id === socket.id
        );

        if (gamePlayerIndex !== -1) {
          // Adjust game state for the other players
          if (game.currentControl.id === socket.id) {
            //  transfer current control to next player
            game.currentControl =
              game.players[(gamePlayerIndex + 1) % game.players.length];
          }
          // shift lead card to next player or set to null
          if (
            game.currentLeadCard &&
            game.currentPlays[0].player.id === socket.id &&
            room.players.length >= 2
          ) {
            game.currentLeadCard =
              game.currentPlays.length > 1 ? game.currentPlays[1].card : null;
          }

          // remove card from current plays and push back to players hand
          const cardPlayed = game.currentPlays.find(
            (p) => p.player.id === socket.id
          )?.card;
          if (cardPlayed && room.players.length >= 2) {
            game.players[gamePlayerIndex].hands.push(cardPlayed);
            game.currentPlays = game.currentPlays.filter(
              (p) => p.player.id !== socket.id
            );
          }

          // Store gamePlayer in disconnected player object
          const timeOutId = setTimeout(() => {
            delete state.pendingReconnectionList[socket.id];
          }, state.DISCONNECT_TIMEOUT_MS);

          state.pendingReconnectionList[socket.id] = {
            player: game.players[gamePlayerIndex],
            roomId: roomId,
            timeOutId: timeOutId,
            gameSate: game.getState(),
          };

          game.players.splice(gamePlayerIndex, 1);

          // finish round if players were waiting for you
          if (
            game.currentPlays.length === room.players.length &&
            game.currentPlays.length >= 2
          ) {
            game.finishRound();
          }

          io.to(roomId).emit("player_left", {
            userId: socket.id,
            playerName: leavingPlayer?.name || "User",
            updatedPlayers: game.players,
            isIntentional: isIntentional,
          });

          io.to(roomId).emit("game_state_update", game.getState());
        }
      } else {
        io.to(roomId).emit("player_left", {
          userId: socket.id,
          playerName: leavingPlayer?.name || "User",
          updatedPlayers: room.players,
          isIntentional: isIntentional,
        });
      }

      if (room.players.length === 0) {
        delete state.rooms[roomId];
        if (state.gameInstances[roomId]) {
          delete state.gameInstances[roomId];
        }
      } else {
        // Handle ownership transfer if the owner left
        if (room.ownerId === socket.id && room.players.length > 0) {
          room.ownerId = room.players[0].id;
          const roomOwnerIndex = room.players.findIndex(
            (p) => p.id === room.ownerId
          );
          room.players[roomOwnerIndex].status = PlayerStatus.READY;

          io.to(roomId).emit("owner_changed", {
            newOwnerId: room.ownerId,
            updatedPlayers: room.players,
          });
        }
      }
      // Update the lobby regardless (player count changed or room removed)
      state.broadcastLobbyUpdate(io);
    }
  }

  // Clean up any pending join requests from this socket
  Object.keys(state.pendingJoinRequests).forEach((requestId) => {
    if (state.pendingJoinRequests[requestId].userId === socket.id) {
      clearTimeout(state.pendingJoinRequests[requestId].timeoutId);
      delete state.pendingJoinRequests[requestId];
    }
  });
}

export function handleReconnection(
  io: Server,
  socket: Socket,
  savedId: string
): void {
  if (!state.pendingReconnectionList[savedId]) {
    const room = Object.values(state.rooms).find((room) => {
      return room.players.some((player) => player.id === socket.id);
    });

    if (room) {
      const game = state.gameInstances[room.id];
      if (game) {
        setTimeout(() => {
          io.to(room.id).emit("game_state_update", game.getState());
        }, 2000);
      }
      return;
    } else {
      sendReconnectionResponse(socket, "failed", "Failed to reconnect");
      return;
    }
  }

  const { player, roomId, timeOutId, gameSate } =
    state.pendingReconnectionList[savedId];

  if (player && roomId) {
    const room = state.rooms[roomId];
    if (room) {
      player.id = socket.id;

      const existingPlayerIndex = room.players.findIndex(
        (p) => p.id === socket.id
      );
      if (existingPlayerIndex !== -1) {
        // Remove the duplicate player
        room.players.splice(existingPlayerIndex, 1);
      }

      // Add player back to room
      if (room.players.length < room.maxPlayers) {
        room.players.push(player);
        state.socketRoomMap[socket.id] = roomId;
        socket.join(roomId);
      } else {
        sendReconnectionResponse(socket, "failed", "Room is full");
        return;
      }

      // Add player back to game instance
      const game = state.gameInstances[roomId];
      if (game) {
        // remove duplicate player from game.players
        const existingGamePlayerIndex = game.players.findIndex(
          (p) => p.id === socket.id
        );
        if (existingGamePlayerIndex !== -1) {
          game.players.splice(existingGamePlayerIndex, 1);
        }

        // remove duplicate player from game.playersToReconnect
        const existingGamePlayerToReconnectIndex =
          game.playersToReconnect.findIndex((p) => p.id === socket.id);
        if (existingGamePlayerToReconnectIndex !== -1) {
          game.playersToReconnect.splice(existingGamePlayerToReconnectIndex, 1);
        }

        if (
          game.currentPlays.length === room.players.length &&
          game.currentPlays.length >= 2
        ) {
          game.finishRound();
        }

        if (
          JSON.stringify(gameSate) === JSON.stringify(game.getState()) ||
          game.cardsPlayed === 5 - player.hands.length
        ) {
          console.log("Game State has not changed adding player directly");
          game.players.push(player);
          sendReconnectionResponse(socket, "success", "Reconnected");
        } else {
          console.log(
            "Game State has changed, player will be added in the next round"
          );
          game.playersToReconnect.push(player);
          sendReconnectionResponse(
            socket,
            "success",
            "Reconnected Waiting for next round"
          );
        }
      }

      clearTimeout(timeOutId);
      delete state.pendingReconnectionList[savedId];

      setTimeout(() => {
        io.to(roomId).emit("game_state_update", game.getState());
      }, 2200);

      socket.to(roomId).emit("player_reconnected", {
        message: `${player.name} has reconnected`,
      });
    } else {
      sendReconnectionResponse(socket, "failed", "Room no longer exists");
    }
  } else {
    sendReconnectionResponse(socket, "failed", "Invalid reconnection data");
  }
}
