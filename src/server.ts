import "dotenv/config";
import * as http from "http";
import { Server } from "socket.io";
import { setupSocket } from "./socket";

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "alive" }));
    return;
  }
});

// Helper to parse allowed origins from env (comma-separated)
const getAllowedOrigins = () => {
  const origins = process.env.ALLOWED_ORIGINS;
  if (!origins) return [];
  return origins.split(",").map((origin) => origin.trim());
};

const allowedOrigins = getAllowedOrigins();

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST"],
  },
  pingTimeout: 5000,
  pingInterval: 6000,
});

setupSocket(io);

// Start the server
const PORT = process.env.PORT || 3000;

server.listen(PORT, () =>
  console.log(`WebSocket server listening on port ${PORT}`)
);
