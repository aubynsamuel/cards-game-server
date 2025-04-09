import * as http from "http";
import { Server, Socket } from "socket.io";
import { CardsGameState, Callbacks, Player } from "./GameTypes";
import {
  CreateRoomPayload,
  JoinRoomPayload,
  LeaveRoomPayload,
  LobbyRoom,
  PlayCardPayload,
  Room,
  StartGamePayload,
  PlayerStatus,
  JoinRequest,
  Message,
  ReconnectionData,
} from "./ServerTypes";

import MultiplayerCardsGame from "./MultiplayerGameClass";

const server = http.createServer();

const io = new Server(server, {
  cors: {
    origin: "*", // Allows all origins for simplicity, restrict in production
    methods: ["GET", "POST"],
  },
  pingTimeout: 5000,
  pingInterval: 6000,
});

const rooms: Record<string, Room> = {};
const socketRoomMap: Record<string, string> = {};
const gameInstances: Record<string, MultiplayerCardsGame> = {};
const pendingJoinRequests: Record<string, JoinRequest> = {};
const pendingReconnectionList: Record<string, ReconnectionData> = {};
const DISCONNECT_TIMEOUT_MS = 1000 * 35;

function getLobbyRooms(): LobbyRoom[] {
  return Object.values(rooms).map((room) => ({
    id: room.id,
    name: room.name,
    players: room.players.length,
    maxPlayers: room.maxPlayers,
    status: room.status,
  }));
}

function broadcastLobbyUpdate(): void {
  io.emit("lobby_rooms", getLobbyRooms());
}

function handleDisconnect(
  socket: Socket,
  isIntentional: boolean = false
): void {
  console.log("User disconnected:", socket.id);
  const roomId = socketRoomMap[socket.id];
  if (roomId && rooms[roomId]) {
    const room = rooms[roomId];
    const playerIndex = room.players.findIndex((p) => p.id === socket.id);

    if (playerIndex !== -1) {
      const leavingPlayer = room.players.splice(playerIndex, 1)[0];
      console.log(
        `${leavingPlayer?.name || "User"} (${socket.id}) left ${roomId}`
      );

      delete socketRoomMap[socket.id];

      const game = gameInstances[roomId];
      if (game) {
        const gamePlayerIndex = game.players.findIndex(
          (p) => p.id === socket.id
        );

        if (gamePlayerIndex !== -1) {
          // Adjust game state for the other players
          if (
            game.currentControl.id === socket.id &&
            room.players.length >= 2
          ) {
            //  transfer current control to next player
            game.currentControl =
              game.players[(gamePlayerIndex + 1) % game.players.length];
            console.log("Current Control Transferred");
          }
          // shift lead card to next player or set to null
          if (
            game.currentLeadCard &&
            game.currentPlays[0].player.id === socket.id
          ) {
            game.currentLeadCard =
              game.currentPlays.length > 1 ? game.currentPlays[1].card : null;
            console.log("Lead Card Shifted");
          }

          // remove card from current plays and push back to players hand
          const cardPlayed = game.currentPlays.find(
            (p) => p.player.id === socket.id
          )?.card;
          console.log("leavingPlayer played", cardPlayed?.suit);
          if (cardPlayed) {
            game.players[gamePlayerIndex].hands.push(cardPlayed);
            game.currentPlays = game.currentPlays.filter(
              (p) => p.player.id !== socket.id
            );
            console.log(
              "Card Played Removed Successfully ",
              game.currentPlays.length
            );
          }

          // Store gamePlayer in disconnected player object
          const timeOutId = setTimeout(() => {
            console.log(
              `Deleted ${
                pendingReconnectionList[socket.id].player.name
              } from game, reconnection is impossible`
            );
            delete pendingReconnectionList[socket.id];
          }, DISCONNECT_TIMEOUT_MS);

          pendingReconnectionList[socket.id] = {
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
            console.log("Finish Round From Server");
            game.finishRound();
          }

          io.to(roomId).emit("player_left", {
            userId: socket.id,
            playerName: leavingPlayer?.name || "User",
            updatedPlayers: game.players,
            isIntentional: isIntentional,
          });

          io.to(roomId).emit("game_state_update", game.getState());

          console.log("Removed player from game", game.players.length);
        }
      } else {
        console.log("Could not remove player, game not found");
        io.to(roomId).emit("player_left", {
          userId: socket.id,
          playerName: leavingPlayer?.name || "User",
          updatedPlayers: room.players,
          isIntentional: isIntentional,
        });
      }

      if (room.players.length === 0) {
        console.log(`Room ${roomId} is empty, deleting.`);
        delete rooms[roomId];
        if (gameInstances[roomId]) {
          delete gameInstances[roomId];
        }
      } else {
        // Handle ownership transfer if the owner left
        if (room.ownerId === socket.id && room.players.length > 0) {
          room.ownerId = room.players[0].id;
          const roomOwnerIndex = room.players.findIndex(
            (p) => p.id === room.ownerId
          );
          room.players[roomOwnerIndex].status = PlayerStatus.READY;

          console.log(
            `Ownership of room ${roomId} transferred to ${room.players[0].name} (${room.ownerId})`
          );
          io.to(roomId).emit("owner_changed", {
            newOwnerId: room.ownerId,
            updatedPlayers: room.players,
          });
        }
      }
      // Update the lobby regardless (player count changed or room removed)
      broadcastLobbyUpdate();
    }
  } else {
    console.log(`Socket ${socket.id} was not in a tracked room.`);
  }

  // Clean up any pending join requests from this socket
  Object.keys(pendingJoinRequests).forEach((requestId) => {
    if (pendingJoinRequests[requestId].userId === socket.id) {
      clearTimeout(pendingJoinRequests[requestId].timeoutId);
      delete pendingJoinRequests[requestId];
    }
  });
}

function handleReconnection(savedId: string, socket: Socket): void {
  if (!pendingReconnectionList[savedId]) {
    const room = Object.values(rooms).find((room) => {
      return room.players.some((player) => player.id === socket.id);
    });

    if (room) {
      const game = gameInstances[room.id];
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

  console.log("User reconnecting:", savedId);
  const { player, roomId, timeOutId, gameSate } =
    pendingReconnectionList[savedId];

  if (player && roomId) {
    const room = rooms[roomId];
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
        socketRoomMap[socket.id] = roomId;
        socket.join(roomId);
        console.log("Reconnected to room");
      } else {
        sendReconnectionResponse(socket, "failed", "Room is full");
        console.log("Reconnection Failed, room is full");
        return;
      }

      // Add player back to game instance
      const game = gameInstances[roomId];
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
          console.log("Finish Round From Server");
          game.finishRound();
        }

        console.log("Cards left with player:", 5 - player.hands.length);
        console.log("CardPlayed: ", game.cardsPlayed);

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
      delete pendingReconnectionList[savedId];

      setTimeout(() => {
        io.to(roomId).emit("game_state_update", game.getState());
      }, 2200);

      console.log(`${player.name} (${socket.id}) reconnected to ${roomId}`);
      socket.to(roomId).emit("player_reconnected", {
        message: `${player.name} has reconnected`,
      });
    } else {
      sendReconnectionResponse(socket, "failed", "Room no longer exists");
      console.log("Reconnection Failed, room no longer exists");
    }
  } else {
    sendReconnectionResponse(socket, "failed", "Invalid reconnection data");
    console.log("Reconnection Failed, invalid reconnection data");
  }
}

const sendReconnectionResponse = (
  socket: Socket,
  status: "success" | "failed",
  message: string
) => {
  setTimeout(() => {
    socket.emit("reconnection_response", { status, message });
  }, 2000);
};

function updatePlayerStatus(
  socket: Socket,
  roomId: string,
  playerId: string,
  newStatus: PlayerStatus,
  forceUpdate: boolean = false
): boolean {
  const room = rooms[roomId];
  if (!room) {
    socket.emit("status_error", { message: "Room not found." });
    return false;
  }

  const playerIndex = room.players.findIndex((p) => p.id === playerId);
  if (playerIndex === -1) {
    socket.emit("status_error", { message: "Player not found in room." });
    return false;
  }

  // Check if room owner is trying to change status away from READY
  if (
    playerId === room.ownerId &&
    newStatus !== PlayerStatus.READY &&
    newStatus !== PlayerStatus.IN_GAME &&
    !forceUpdate
  ) {
    socket.emit("status_error", { message: "Room owner is always ready." });
    return false;
  }

  // Update player status
  const previousStatus = room.players[playerIndex].status;
  room.players[playerIndex].status = newStatus;

  console.log(
    `Player ${room.players[playerIndex].name} status changed from ${previousStatus} to ${newStatus}`
  );

  // Notify all players in the room about status change
  io.to(roomId).emit("player_status_changed", {
    userId: playerId,
    playerName: room.players[playerIndex].name,
    newStatus,
    updatedPlayers: room.players,
  });

  return true;
}

// --- Socket Event Listeners ---

io.on("connection", (socket: Socket) => {
  console.log("A user connected:", socket.id);

  // Send initial list of rooms to the newly connected client
  socket.emit("lobby_rooms", getLobbyRooms());

  // Listener: Handle request for updated lobby rooms (for refresh)
  socket.on("request_lobby_rooms", () => {
    socket.emit("lobby_rooms", getLobbyRooms());
  });

  socket.on("reconnection", ({ savedId }: { savedId: string }) => {
    console.log("User tried to reconnect with ", savedId);
    handleReconnection(savedId, socket);
  });

  socket.on("get_room", ({ roomId }: { roomId: string }) => {
    const room = rooms[roomId];
    socket.emit("get_room_response", { room });
  });

  socket.on(
    "update_player_status",
    ({ roomId, status }: { roomId: string; status: PlayerStatus }) => {
      if (socketRoomMap[socket.id] !== roomId) {
        socket.emit("status_error", { message: "Not in the specified room." });
        return;
      }

      updatePlayerStatus(socket, roomId, socket.id, status);
    }
  );

  // Listener: Create a new room
  socket.on(
    "create_room",
    ({ playerName, roomName, id }: CreateRoomPayload) => {
      // Prevent user from creating multiple rooms or joining while in another
      if (socketRoomMap[socket.id]) {
        socket.emit("create_error", { message: "You are already in a room." });
        return;
      }

      const roomId = `room_${Date.now()}_${Math.random()
        .toString(36)
        .substring(2, 7)}`;

      // Create a new player with the correct structure based on the Player interface
      const newPlayer: Player = {
        id: id || socket.id,
        name: playerName || `Player_${socket.id.substring(0, 4)}`,
        hands: [],
        score: 0,
        status: PlayerStatus.READY, // Owner is automatically ready
      };

      const newRoom: Room = {
        id: roomId,
        name: roomName || `${playerName}'s Game`,
        players: [newPlayer],
        maxPlayers: 4,
        status: "waiting",
        ownerId: socket.id,
        messages: [],
      };

      rooms[roomId] = newRoom;
      socket.join(roomId);
      socketRoomMap[socket.id] = roomId;

      console.log(`Room ${roomId} created by ${playerName} (${socket.id})`);
      socket.emit("room_created", { roomId: roomId, room: rooms[roomId] });
      broadcastLobbyUpdate();
    }
  );

  // Listener: Send a message to a room
  socket.on(
    "send_message",
    ({ roomId, message }: { roomId: string; message: Message }) => {
      const room = rooms[roomId];
      if (room) {
        room.messages.push(message);
        io.to(roomId).emit("message_received", { message });
      }
    }
  );

  // Listener: Request to join a room
  socket.on(
    "request_join_room",
    ({ roomId, playerName, id }: JoinRoomPayload) => {
      if (socketRoomMap[socket.id]) {
        socket.emit("join_error", { message: "You are already in a room." });
        return;
      }

      const room = rooms[roomId];
      if (!room) {
        socket.emit("join_error", { message: "Room not found" });
        return;
      }

      if (room.status !== "waiting" || room.players.length >= room.maxPlayers) {
        socket.emit("join_error", { message: "Room not available or full" });
        return;
      }

      // Create a unique request ID
      const requestId = `req_${Date.now()}_${Math.random()
        .toString(36)
        .substring(2, 7)}`;

      // Send join request to room owner
      io.to(room.ownerId).emit("join_request", {
        requestId,
        userId: socket.id,
        playerName: playerName || `Player_${socket.id.substring(0, 4)}`,
      });

      // Set a timeout for auto-rejection after 5 seconds
      const timeoutId = setTimeout(() => {
        if (pendingJoinRequests[requestId]) {
          // Auto-reject if owner hasn't responded
          socket.emit("join_request_response", {
            accepted: false,
            requestId,
            message: `Request to join ${room.name} timed out`,
          });
          delete pendingJoinRequests[requestId];
        }
      }, 5000);

      // Store the request
      pendingJoinRequests[requestId] = {
        requestId,
        playerName: playerName || `Player_${socket.id.substring(0, 4)}`,
        roomId,
        userId: id || socket.id,
        timeoutId,
      };

      console.log(`Join request ${requestId} sent to room owner for ${roomId}`);
    }
  );

  // Listener: Owner responds to join request
  socket.on(
    "respond_to_join_request",
    ({ requestId, accepted }: { requestId: string; accepted: boolean }) => {
      const request = pendingJoinRequests[requestId];

      if (!request) {
        socket.emit("response_error", {
          message: "Join request not found or expired",
        });
        return;
      }

      const room = rooms[request.roomId];

      // Verify that the responder is the room owner
      if (room && room.ownerId === socket.id) {
        clearTimeout(request.timeoutId);

        const userSocket = io.sockets.sockets.get(request.userId);
        if (!userSocket) {
          socket.emit("response_error", {
            message: "Requesting user disconnected",
          });
          delete pendingJoinRequests[requestId];
          return;
        }

        if (accepted) {
          // Create a new joining player with the correct structure
          const joiningPlayer: Player = {
            id: request.userId,
            name: request.playerName,
            hands: [],
            score: 0,
            status: PlayerStatus.NOT_READY, // New players start not ready
          };

          room.players.push(joiningPlayer);
          userSocket.join(request.roomId);
          socketRoomMap[request.userId] = request.roomId;

          console.log(
            `${joiningPlayer.name} (${request.userId}) joined room ${request.roomId}`
          );

          userSocket.emit("room_created", {
            roomId: request.roomId,
            room: room,
          });

          io.to(request.roomId).emit("player_joined", {
            userId: request.userId,
            playerName: joiningPlayer.name,
            updatedPlayers: room.players,
          });

          // Notify the requesting user of acceptance
          userSocket.emit("join_request_response", {
            accepted: true,
            requestId,
            message: "Request accepted",
            roomId: request.roomId,
            roomData: room,
          });

          broadcastLobbyUpdate();
        } else {
          // Notify the requesting user of rejection
          userSocket.emit("join_request_response", {
            accepted: false,
            requestId,
            message: `Request to join ${room.name} declined`,
          });
        }

        delete pendingJoinRequests[requestId];
      } else {
        socket.emit("response_error", {
          message: "Only the room owner can accept or reject join requests",
        });
      }
    }
  );

  // Listener: Owner kicking player out of the room
  socket.on("kick_player", ({ playerToKickId }: { playerToKickId: string }) => {
    const playerToKickSocket = io.sockets.sockets.get(playerToKickId);
    const roomId = socketRoomMap[socket.id];
    const room = rooms[roomId];
    const player = room.players.find((p) => p.id === playerToKickId);

    if (!playerToKickSocket || room.ownerId !== socket.id) return;
    handleDisconnect(playerToKickSocket);
    io.to(playerToKickId).emit("player_kicked", {
      message: `You have been kicked from the room`,
    });
    console.log(`${player?.name} has been kicked from room ${roomId}`);
  });

  // Listener: Leave a room
  socket.on("leave_room", ({ roomId }: LeaveRoomPayload) => {
    if (socketRoomMap[socket.id] === roomId && rooms[roomId]) {
      handleDisconnect(socket, true);
    } else {
      socket.emit("leave_error", { message: "Not in the specified room." });
    }
  });

  // Listener: Start the game (only owner can start)
  socket.on("start_game", ({ roomId, gameTo }: StartGamePayload) => {
    const room = rooms[roomId];
    if (room && room.ownerId === socket.id && room.status === "waiting") {
      if (room.players.length >= 2 && room.players.length <= 4) {
        // Check if all players are ready
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
        console.log(`Game starting in room ${roomId}`);

        // Update player statuses to IN_GAME
        room.players.forEach((player) => {
          updatePlayerStatus(
            socket,
            roomId,
            player.id,
            PlayerStatus.IN_GAME,
            true
          );
        });

        // Players are already in the correct format with hands and score
        const gamePlayers = room.players;

        // Create a new game instance for this room
        const game = new MultiplayerCardsGame(gamePlayers, gameTo);

        // Set up callbacks with proper typing
        const callbacks: Callbacks = {
          onStateChange: (newState: CardsGameState) => {
            io.to(roomId).emit("game_state_update", newState);
          },
          onRoundFinished: () => {},
        };

        game.setCallbacks(callbacks);
        gameInstances[roomId] = game;
        game.startGame();
        io.to(roomId).emit("game_started", { roomId, roomData: room });
        broadcastLobbyUpdate();
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
  });

  socket.on("game_ended", ({ roomId }: { roomId: string }) => {
    const room = rooms[roomId];
    if (room && room.status !== "waiting") {
      room.status = "waiting";
      broadcastLobbyUpdate();

      // Reset all player statuses to NOT_READY except owner
      room.players.forEach((player) => {
        const newStatus =
          player.id === room.ownerId
            ? PlayerStatus.READY
            : PlayerStatus.NOT_READY;

        updatePlayerStatus(socket, roomId, player.id, newStatus, true);
      });
      console.log("Room Has Been Set To Waiting");
    }
  });

  // Listener: Player plays a card
  socket.on(
    "play_card",
    ({ roomId, playerId, card, cardIndex }: PlayCardPayload) => {
      console.log(`Player ${playerId} played card ${card} in room ${roomId}`);
      const game = gameInstances[roomId];
      if (game) {
        // Ensure the player ID matches what's expected in the game (playerId can be string or number)
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
  );

  // Listener: Client disconnected
  socket.on("disconnect", (reason) => {
    handleDisconnect(socket);
    console.log(reason);
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`WebSocket server listening on port ${PORT}`)
);
