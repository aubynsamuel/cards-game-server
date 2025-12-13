import { Server } from "socket.io";
import MultiplayerCardsGame from "./game/MultiplayerGameClass";
import { LobbyRoom, Room, JoinRequest, ReconnectionData } from "./types/ServerTypes";

export const rooms: Record<string, Room> = {};
export const socketRoomMap: Record<string, string> = {};
export const gameInstances: Record<string, MultiplayerCardsGame> = {};
export const pendingJoinRequests: Record<string, JoinRequest> = {};
export const pendingReconnectionList: Record<string, ReconnectionData> = {};
export const DISCONNECT_TIMEOUT_MS = 1000 * 35;

export function getLobbyRooms(): LobbyRoom[] {
  return Object.values(rooms).map((room) => ({
    id: room.id,
    name: room.name,
    players: room.players.length,
    maxPlayers: room.maxPlayers,
    status: room.status,
  }));
}

export function broadcastLobbyUpdate(io: Server): void {
  io.emit("lobby_rooms", getLobbyRooms());
}
