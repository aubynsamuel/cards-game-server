import { Server, Socket } from "socket.io";
import * as state from "../state";
import { CreateRoomPayload, JoinRoomPayload, LeaveRoomPayload, Message, PlayerStatus, Room } from "../types/ServerTypes";
import { Player } from "../types/GameTypes";
import { handleDisconnect } from "./connectionHandlers";

export function updatePlayerStatus(
    io: Server,
    socket: Socket,
    roomId: string,
    playerId: string,
    newStatus: PlayerStatus,
    forceUpdate: boolean = false
  ): boolean {
    const room = state.rooms[roomId];
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
  
    room.players[playerIndex].status = newStatus;
  
    // Notify all players in the room about status change
    io.to(roomId).emit("player_status_changed", {
      userId: playerId,
      playerName: room.players[playerIndex].name,
      newStatus,
      updatedPlayers: room.players,
    });
  
    return true;
}

export function createRoom(io: Server, socket: Socket, { playerName, roomName, id }: CreateRoomPayload) {
    if (state.socketRoomMap[socket.id]) {
        socket.emit("create_error", { message: "You are already in a room." });
        return;
    }

    const roomId = `room_${Date.now()}_${Math.random()
        .toString(36)
        .substring(2, 7)}`;

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

    state.rooms[roomId] = newRoom;
    socket.join(roomId);
    state.socketRoomMap[socket.id] = roomId;

    socket.emit("room_created", { roomId: roomId, room: state.rooms[roomId] });
    state.broadcastLobbyUpdate(io);
}

export function sendMessage(io: Server, socket: Socket, { roomId, message }: { roomId: string; message: Message }) {
    const room = state.rooms[roomId];
    if (room) {
        room.messages.push(message);
        io.to(roomId).emit("message_received", { message });
    }
}

export function requestJoinRoom(io: Server, socket: Socket, { roomId, playerName, id }: JoinRoomPayload) {
    if (state.socketRoomMap[socket.id]) {
        socket.emit("join_error", { message: "You are already in a room." });
        return;
    }

    const room = state.rooms[roomId];
    if (!room) {
        socket.emit("join_error", { message: "Room not found" });
        return;
    }

    if (room.status !== "waiting" || room.players.length >= room.maxPlayers) {
        socket.emit("join_error", { message: "Room not available or full" });
        return;
    }

    const requestId = `req_${Date.now()}_${Math.random()
        .toString(36)
        .substring(2, 7)}`;

    io.to(room.ownerId).emit("join_request", {
        requestId,
        userId: socket.id,
        playerName: playerName || `Player_${socket.id.substring(0, 4)}`,
    });

    const timeoutId = setTimeout(() => {
        if (state.pendingJoinRequests[requestId]) {
            socket.emit("join_request_response", {
                accepted: false,
                requestId,
                message: `Request to join ${room.name} timed out`,
            });
            delete state.pendingJoinRequests[requestId];
        }
    }, 5000);

    state.pendingJoinRequests[requestId] = {
        requestId,
        playerName: playerName || `Player_${socket.id.substring(0, 4)}`,
        roomId,
        userId: id || socket.id,
        timeoutId,
    };
}

export function respondToJoinRequest(io: Server, socket: Socket, { requestId, accepted }: { requestId: string; accepted: boolean }) {
    const request = state.pendingJoinRequests[requestId];

    if (!request) {
        socket.emit("response_error", {
            message: "Join request not found or expired",
        });
        return;
    }

    const room = state.rooms[request.roomId];

    if (room && room.ownerId === socket.id) {
        clearTimeout(request.timeoutId);

        const userSocket = io.sockets.sockets.get(request.userId);
        if (!userSocket) {
            socket.emit("response_error", {
                message: "Requesting user disconnected",
            });
            delete state.pendingJoinRequests[requestId];
            return;
        }

        if (accepted) {
            const joiningPlayer: Player = {
                id: request.userId,
                name: request.playerName,
                hands: [],
                score: 0,
                status: PlayerStatus.NOT_READY,
            };

            room.players.push(joiningPlayer);
            userSocket.join(request.roomId);
            state.socketRoomMap[request.userId] = request.roomId;

            userSocket.emit("room_created", {
                roomId: request.roomId,
                room: room,
            });

            io.to(request.roomId).emit("player_joined", {
                userId: request.userId,
                playerName: joiningPlayer.name,
                updatedPlayers: room.players,
            });

            userSocket.emit("join_request_response", {
                accepted: true,
                requestId,
                message: "Request accepted",
                roomId: request.roomId,
                roomData: room,
            });

            state.broadcastLobbyUpdate(io);
        } else {
            userSocket.emit("join_request_response", {
                accepted: false,
                requestId,
                message: `Request to join ${room.name} declined`,
            });
        }

        delete state.pendingJoinRequests[requestId];
    } else {
        socket.emit("response_error", {
            message: "Only the room owner can accept or reject join requests",
        });
    }
}

export function kickPlayer(io: Server, socket: Socket, { playerToKickId }: { playerToKickId: string }) {
    const playerToKickSocket = io.sockets.sockets.get(playerToKickId);
    const roomId = state.socketRoomMap[socket.id];
    const room = state.rooms[roomId];

    if (!playerToKickSocket || !room || room.ownerId !== socket.id) return;
    
    handleDisconnect(io, playerToKickSocket, true);
    io.to(playerToKickId).emit("player_kicked", {
        message: `You have been kicked from the room`,
    });
}

export function leaveRoom(io: Server, socket: Socket, { roomId }: LeaveRoomPayload) {
    if (state.socketRoomMap[socket.id] === roomId && state.rooms[roomId]) {
        handleDisconnect(io, socket, true);
    } else {
        socket.emit("leave_error", { message: "Not in the specified room." });
    }
}

export function updatePlayerStatusHandler(io: Server, socket: Socket, { roomId, status }: { roomId: string; status: PlayerStatus }) {
    if (state.socketRoomMap[socket.id] !== roomId) {
        socket.emit("status_error", { message: "Not in the specified room." });
        return;
    }
    updatePlayerStatus(io, socket, roomId, socket.id, status);
}

export function getRoom(io: Server, socket: Socket, { roomId }: { roomId: string }) {
    const room = state.rooms[roomId];
    socket.emit("get_room_response", { room });
}
