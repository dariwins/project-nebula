
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const MAX_PLAYERS = 15;

function makeCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      alive: p.alive,
      color: p.color
    })),
    votes: room.phase === "meeting" ? room.votes.size : 0
  };
}

function updateRoom(room) {
  io.to(room.code).emit("state", publicState(room));
}

function tell(socket, message) {
  socket.emit("notice", message);
}

function finishMeeting(room) {
  if (room.phase !== "meeting") return;

  const counts = {};
  for (const target of room.votes.values()) {
    if (target !== "skip") {
      counts[target] = (counts[target] || 0) + 1;
    }
  }

  const max = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter(id => counts[id] === max);
  let ejected = null;

  if (max > 0 && leaders.length === 1) {
    const player = room.players.get(leaders[0]);
    if (player && player.alive) {
      player.alive = false;
      ejected = player.name;
    }
  }

  room.phase = "playing";
  room.votes.clear();

  io.to(room.code).emit(
    "meeting-result",
    ejected
      ? `${ejected} fue expulsado.`
      : "Nadie fue expulsado."
  );

  checkWin(room);
  updateRoom(room);
}

function checkWin(room) {
  if (room.phase !== "playing") return;

  const alive = [...room.players.values()].filter(p => p.alive);
  const impostors = alive.filter(p => p.role === "impostor");
  const crew = alive.filter(p => p.role !== "impostor");

  if (impostors.length === 0) {
    room.phase = "ended";
    io.to(room.code).emit("game-over", "¡Ganan los tripulantes!");
  } else if (impostors.length >= crew.length) {
    room.phase = "ended";
    io.to(room.code).emit("game-over", "¡Ganan los impostores!");
  }
}

function removePlayer(socket) {
  const code = socket.data.roomCode;
  if (!code) return;

  const room = rooms.get(code);
  socket.data.roomCode = null;
  if (!room) return;

  room.players.delete(socket.id);
  room.votes.delete(socket.id);

  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }

  if (!room.players.has(room.hostId)) {
    room.hostId = room.players.keys().next().value;
  }

  if (room.phase === "meeting" &&
      room.votes.size >= [...room.players.values()].filter(p => p.alive).length) {
    finishMeeting(room);
  } else {
    if (room.phase === "playing") checkWin(room);
    updateRoom(room);
  }
}

io.on("connection", socket => {
  socket.on("create-room", name => {
    if (socket.data.roomCode) removePlayer(socket);

    const code = makeCode();
    const room = {
      code,
      hostId: socket.id,
      players: new Map(),
      phase: "lobby",
      votes: new Map()
    };

    room.players.set(socket.id, {
      id: socket.id,
      name: cleanName(name),
      x: 100,
      y: 100,
      alive: true,
      role: "crew",
      color: 0
    });

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("joined", { code, id: socket.id });
    updateRoom(room);
  });

  socket.on("join-room", ({ code, name } = {}) => {
    if (socket.data.roomCode) removePlayer(socket);

    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return tell(socket, "No existe esa sala.");
    if (room.phase !== "lobby") return tell(socket, "La partida ya comenzó.");
    if (room.players.size >= MAX_PLAYERS) {
      return tell(socket, "La sala está llena (15 jugadores).");
    }

    room.players.set(socket.id, {
      id: socket.id,
      name: cleanName(name),
      x: 100 + Math.random() * 300,
      y: 100 + Math.random() * 180,
      alive: true,
      role: "crew",
      color: room.players.size % 12
    });

    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("joined", { code, id: socket.id });
    updateRoom(room);
  });

  socket.on("start-game", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== "lobby") return;
    if (room.players.size < 3) {
      return tell(socket, "Necesitan al menos 3 jugadores.");
    }

    const players = [...room.players.values()];
    players.forEach(p => {
      p.alive = true;
      p.role = "crew";
      p.x = 100 + Math.random() * 300;
      p.y = 100 + Math.random() * 180;
    });

    const impostor = players[Math.floor(Math.random() * players.length)];
    impostor.role = "impostor";

    room.votes.clear();
    room.phase = "playing";

    for (const p of players) {
      io.to(p.id).emit("your-role", p.role);
    }

    io.to(room.code).emit("notice", "¡La partida comenzó!");
    updateRoom(room);
  });

  socket.on("move", ({ x, y } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const p = room?.players.get(socket.id);
    if (!room || room.phase !== "playing" || !p || !p.alive) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    p.x = Math.max(20, Math.min(580, x));
    p.y = Math.max(20, Math.min(380, y));
    updateRoom(room);
  });

  socket.on("kill", targetId => {
    const room = rooms.get(socket.data.roomCode);
    const killer = room?.players.get(socket.id);
    const target = room?.players.get(targetId);

    if (!room || room.phase !== "playing") return;
    if (!killer || !target || !killer.alive || !target.alive) return;
    if (killer.role !== "impostor" || target.id === killer.id) return;

    const distance = Math.hypot(killer.x - target.x, killer.y - target.y);
    if (distance > 45) return;

    target.alive = false;
    io.to(room.code).emit("notice", "¡Un jugador ha sido eliminado!");
    checkWin(room);
    updateRoom(room);
  });

  socket.on("report", () => {
    const room = rooms.get(socket.data.roomCode);
    const p = room?.players.get(socket.id);
    if (!room || room.phase !== "playing" || !p?.alive) return;

    room.phase = "meeting";
    room.votes.clear();
    io.to(room.code).emit("meeting-start");
    updateRoom(room);
  });

  socket.on("vote", targetId => {
    const room = rooms.get(socket.data.roomCode);
    const p = room?.players.get(socket.id);
    if (!room || room.phase !== "meeting" || !p?.alive) return;
    if (room.votes.has(socket.id)) return;

    const valid = targetId === "skip" ||
      (room.players.has(targetId) && room.players.get(targetId).alive);

    if (!valid) return;
    room.votes.set(socket.id, targetId);

    const aliveCount = [...room.players.values()].filter(p => p.alive).length;
    if (room.votes.size >= aliveCount) finishMeeting(room);
    else updateRoom(room);
  });

  socket.on("leave-room", () => removePlayer(socket));
  socket.on("disconnect", () => removePlayer(socket));
});

function cleanName(name) {
  return String(name || "Jugador")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 16) || "Jugador";
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Project Nebula está escuchando en el puerto " + PORT);
});
