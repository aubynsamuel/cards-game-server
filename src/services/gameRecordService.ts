import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../firebase";
import { CardsGameState, GameRecord } from "../types/GameTypes";

export function createMultiplayerGameRecord(
  gameId: string,
  state: CardsGameState
): GameRecord | null {
  const winner = state.gameOverData.winner;
  if (!winner || winner.score < state.gameTo) return null;

  const rankedPlayers = [...state.players].sort((a, b) => b.score - a.score);

  return {
    gameId,
    dateString: new Date().toUTCString(),
    targetScore: state.gameTo,
    playerCount: state.players.length,
    mode: "multiplayer",
    winnerId: winner.userId ?? winner.id,
    winnerName: winner.name,
    players: rankedPlayers.map((player, index) => ({
      id: player.userId ?? player.id,
      name: player.name,
      finalScore: player.score,
      position: index + 1,
    })),
  };
}

export async function saveMultiplayerGameRecord(
  record: GameRecord,
  state: CardsGameState
): Promise<void> {
  const authenticatedUserIds = new Set(
    state.players
      .map((player) => player.userId)
      .filter((userId): userId is string => Boolean(userId))
  );

  if (authenticatedUserIds.size === 0) return;

  const batch = firestore.batch();
  for (const userId of authenticatedUserIds) {
    const ref = firestore.doc(`users/${userId}/game_records/${record.gameId}`);
    batch.set(
      ref,
      { ...record, createdAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  await batch.commit();
}

export async function saveSinglePlayerGameRecord(
  userId: string,
  record: GameRecord
): Promise<void> {
  const ref = firestore.doc(`users/${userId}/game_records/${record.gameId}`);
  await ref.set(
    { ...record, createdAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
}
