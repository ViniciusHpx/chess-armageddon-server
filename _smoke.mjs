import { Client } from "@colyseus/sdk";
const c = new Client("wss://chess-armageddon-server.onrender.com");
try {
  const room = await c.joinOrCreate("arena", { name: "SmokeTest" });
  console.log("JOINED roomId=", room.roomId, "sessionId=", room.sessionId);
  await new Promise(r => setTimeout(r, 2000));
  console.log("actors=", room.state?.actors?.size ?? "(campo actors nao existe)");
  await room.leave();
  process.exit(0);
} catch (e) {
  console.log("FAIL:", e?.message || e);
  process.exit(1);
}
