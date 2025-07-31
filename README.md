# Card Masters Server

A Socket.io based server for a real-time multiplayer card game, Card Masters.

## Features

- Create and join game rooms
- Real-time gameplay with Socket.io
- Player reconnection support
- In-game chat functionality
- Room management (kick players, transfer ownership)
- Game state synchronization across clients

## Client Application

This server is designed to work with the React Native client application. The client application can be found at **[Card Masters](https://github.com/aubynsamuel/cardmasters-rn)**

## Getting Started

### Prerequisites

- Node.js
- npm or yarn

### Installation

1. Clone the repository
2. Install dependencies:

   ```bash
   yarn install
   ```

3. Start the server:

   ```bash
   yarn dev
   ```

## How It Works

The server manages game rooms, player connections, and game state. Players can:

- Create rooms
- Join existing rooms
- Play cards during their turn
- Chat with other players
- Reconnect if disconnected

## Technologies Used

- Node.js
- TypeScript
- Socket.io
- HTTP

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
