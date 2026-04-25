const express = require("express");
const path = require("path");
const displayRoutes = require("./displayRoutes");

const app = express();
const PORT = process.env.KIOSK_PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Mount Phase 1 display API
app.use("/api", displayRoutes);

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Kiosk display server listening on port ${PORT}`);
});