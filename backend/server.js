const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// ------------------------------
// CORS
// ------------------------------
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
  })
);

// ------------------------------
// Socket.IO
// ------------------------------
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ------------------------------
// Socket.IO Connection
// ------------------------------
io.on("connection", (socket) => {
  console.log("🟢 User connected:", socket.id);

  // Create room
  socket.on("create-room", (roomId) => {
    socket.join(roomId);

    console.log(`🏠 Room created: ${roomId}`);

    socket.emit("room-created", roomId);
  });

  // Join room
  socket.on("join-room", (roomId) => {
    socket.join(roomId);

    console.log(`📱 User ${socket.id} joined room ${roomId}`);

    socket.to(roomId).emit("user-joined", socket.id);
  });

  // WebRTC Offer
  socket.on("offer", ({ roomId, offer }) => {
    console.log(`📨 Sending offer to room ${roomId}`);

    socket.to(roomId).emit("offer", {
      offer,
      roomId,
    });
  });

  // WebRTC Answer
  socket.on("answer", ({ roomId, answer }) => {
    console.log(`📨 Sending answer to room ${roomId}`);

    socket.to(roomId).emit("answer", {
      answer,
    });
  });

  // WebRTC ICE Candidate
  socket.on("ice-candidate", ({ roomId, candidate }) => {
    socket.to(roomId).emit("ice-candidate", {
      candidate,
    });
  });

  // Disconnect
  socket.on("disconnect", (reason) => {
    console.log(`🔴 User disconnected: ${socket.id}`);
    console.log(`Reason: ${reason}`);
  });
});

// ------------------------------
// Health Check
// ------------------------------
app.get("/", (req, res) => {
  res.status(200).send("SyncSound server is running 🚀");
});

// ------------------------------
// Render Port
// ------------------------------
const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 SyncSound server running on port ${PORT}`);
});