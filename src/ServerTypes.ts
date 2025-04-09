import { Card, CardsGameState, Player } from "./GameTypes";

type RoomStatus = "waiting" | "playing" | "finished";

interface Room {
  id: string;
  name: string;
  players: Player[];
  maxPlayers: number;
  status: RoomStatus;
  ownerId: string;
  messages: Message[];
}

interface Message {
  text: string;
  senderName: string;
  senderId: string;
  timestamp: Date;
}

interface LobbyRoom {
  id: string;
  name: string;
  players: number;
  maxPlayers: number;
  status: string;
}

// Event payload types
interface CreateRoomPayload {
  playerName: string;
  roomName?: string;
  id: string;
}

interface JoinRoomPayload {
  roomId: string;
  playerName: string;
  id: string;
}

interface LeaveRoomPayload {
  roomId: string;
}

interface StartGamePayload {
  roomId: string;
  gameTo: number;
}

interface PlayCardPayload {
  roomId: string;
  playerId: string;
  card: Card;
  cardIndex: number;
}

enum PlayerStatus {
  NOT_READY = "NOT_READY",
  READY = "READY",
  IN_GAME = "IN_GAME",
  VIEWING_RESULTS = "VIEWING_RESULTS",
}

interface JoinRequestPayload {
  requestId: string;
  userId: string;
  playerName: string;
}

interface JoinRequestResponsePayload {
  accepted: boolean;
  requestId: string;
  message: string;
  roomId?: string;
  roomData?: Room;
}

interface PlayerStatusChangedPayload {
  userId: string;
  playerName: string;
  newStatus: PlayerStatus;
  updatedPlayers: Player[];
}
interface JoinRequest {
  requestId: string;
  userId: string;
  playerName: string;
  roomId: string;
  timeoutId: NodeJS.Timeout;
}
interface ReconnectionData {
  player: Player;
  roomId: string;
  timeOutId: NodeJS.Timeout;
  gameSate: CardsGameState;
}

export {
  Room,
  LobbyRoom,
  CreateRoomPayload,
  JoinRoomPayload,
  LeaveRoomPayload,
  StartGamePayload,
  PlayCardPayload,
  PlayerStatusChangedPayload,
  JoinRequestPayload,
  JoinRequestResponsePayload,
  PlayerStatus,
  JoinRequest,
  Message,
  ReconnectionData,
};
