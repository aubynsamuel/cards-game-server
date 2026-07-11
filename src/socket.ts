import { Server, Socket } from "socket.io";
import * as connectionHandlers from "./handlers/connectionHandlers";
import * as roomHandlers from "./handlers/roomHandlers";
import * as gameHandlers from "./handlers/gameHandlers";
import * as state from "./state";
import {
  CreateRoomPayload,
  JoinRoomPayload,
  LeaveRoomPayload,
  PlayCardPayload,
  StartGamePayload,
  PlayerStatus,
  Message,
} from "./types/ServerTypes";
import { firebaseAuth } from "./firebase";

export function setupSocket(io: Server) {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
      socket.data.userId = undefined;
      next();
      return;
    }

    try {
      const decodedToken = await firebaseAuth.verifyIdToken(token);
      socket.data.userId = decodedToken.uid;
      next();
    } catch {
      next(new Error("Invalid or expired authentication token"));
    }
  });

  io.on("connection", (socket: Socket) => {
    console.log("A user connected:", socket.id);

    socket.emit("lobby_rooms", state.getLobbyRooms());

    socket.on("request_lobby_rooms", () => {
      socket.emit("lobby_rooms", state.getLobbyRooms());
    });

    socket.on("reconnection", ({ savedId }: { savedId: string }) => {
      connectionHandlers.handleReconnection(io, socket, savedId);
    });

    socket.on("get_room", (payload: { roomId: string }) => {
      roomHandlers.getRoom(io, socket, payload);
    });

    socket.on(
      "update_player_status",
      (payload: { roomId: string; status: PlayerStatus }) => {
        roomHandlers.updatePlayerStatusHandler(io, socket, payload);
      }
    );

    socket.on("create_room", (payload: CreateRoomPayload) => {
      roomHandlers.createRoom(io, socket, payload);
    });

    socket.on(
      "send_message",
      (payload: { roomId: string; message: Message }) => {
        roomHandlers.sendMessage(io, socket, payload);
      }
    );

    socket.on("request_join_room", (payload: JoinRoomPayload) => {
      roomHandlers.requestJoinRoom(io, socket, payload);
    });

    socket.on(
      "respond_to_join_request",
      (payload: { requestId: string; accepted: boolean }) => {
        roomHandlers.respondToJoinRequest(io, socket, payload);
      }
    );

    socket.on("kick_player", (payload: { playerToKickId: string }) => {
      roomHandlers.kickPlayer(io, socket, payload);
    });

    socket.on("leave_room", (payload: LeaveRoomPayload) => {
      roomHandlers.leaveRoom(io, socket, payload);
    });

    socket.on("start_game", (payload: StartGamePayload) => {
      gameHandlers.startGame(io, socket, payload);
    });

    socket.on("game_ended", (payload: { roomId: string }) => {
      gameHandlers.gameEnded(io, socket, payload);
    });

    socket.on(
      "sync_single_player_record",
      (
        payload: { record?: unknown },
        acknowledge?: (response: {
          ok: boolean;
          gameId?: string;
          error?: string;
        }) => void
      ) => {
        const safeAcknowledge =
          typeof acknowledge === "function" ? acknowledge : () => undefined;
        void gameHandlers.syncSinglePlayerRecord(
          socket,
          payload,
          safeAcknowledge
        );
      }
    );

    socket.on("play_card", (payload: PlayCardPayload) => {
      gameHandlers.playCard(io, socket, payload);
    });

    socket.on("disconnect", (reason) => {
      connectionHandlers.handleDisconnect(io, socket);
      console.log(reason);
    });
  });
}
