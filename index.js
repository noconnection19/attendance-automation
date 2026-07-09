const cron = require("node-cron");

// ============================================================
// Configuration
// ============================================================
const CONFIG = {
  apiBase: "https://prms-api.fid-app.my.id/api",
  email: process.env.EMAIL,
  password: process.env.PASSWORD,
  baseLatitude: parseFloat(process.env.BASE_LATITUDE || "-6.159868350846804"),
  baseLongitude: parseFloat(process.env.BASE_LONGITUDE || "106.87936991839877"),
  defaultNote: process.env.NOTE || "Standby POC AURORA",
};

// ============================================================
// Utility Functions
// ============================================================

/**
 * Get current timestamp in WIB format for logging
 */
function getTimestamp() {
  return new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Log with timestamp
 */
function log(message) {
  console.log(`[${getTimestamp()}] ${message}`);
}

/**
 * Generate random integer between min and max (inclusive)
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate random float between min and max
 */
function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * Sleep for given milliseconds
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Add jitter to coordinates (±0.0001 to ±0.0005)
 * Membuat variasi lokasi kecil agar tidak persis sama setiap hari
 */
function jitterCoordinate(base) {
  const jitter = randomFloat(-0.0005, 0.0005);
  return parseFloat((base + jitter).toFixed(15));
}

/**
 * Check if today is a weekend (Saturday or Sunday)
 */
function isWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6; // 0 = Sunday, 6 = Saturday
}

/**
 * Get today's day name for logging
 */
function getDayName() {
  const days = [
    "Minggu",
    "Senin",
    "Selasa",
    "Rabu",
    "Kamis",
    "Jumat",
    "Sabtu",
  ];
  return days[new Date().getDay()];
}

// ============================================================
// API Functions
// ============================================================

/**
 * Login to PRMS and get the token cookie
 */
async function login() {
  log("Attempting login...");

  const response = await fetch(`${CONFIG.apiBase}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Origin: "https://prms.fid-app.my.id",
      Referer: "https://prms.fid-app.my.id/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({
      email: CONFIG.email,
      password: CONFIG.password,
    }),
    redirect: "manual",
  });

  if (!response.ok) {
    throw new Error(`Login failed with status: ${response.status}`);
  }

  // Extract token from Set-Cookie header
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("No Set-Cookie header in login response");
  }

  const tokenMatch = setCookie.match(/token=([^;]+)/);
  if (!tokenMatch) {
    throw new Error("Token not found in Set-Cookie header");
  }

  const token = tokenMatch[1];
  const data = await response.json();
  log(`Login berhasil sebagai: ${data.user?.name || CONFIG.email}`);

  return token;
}

/**
 * Get today's check-in and check-out status
 */
async function getAttendanceStatus(token) {
  const now = new Date();
  
  // Format month and year based on Jakarta timezone
  const month = now.toLocaleDateString("en-US", { timeZone: "Asia/Jakarta", month: "numeric" });
  const year = now.toLocaleDateString("en-US", { timeZone: "Asia/Jakarta", year: "numeric" });
  
  const url = `${CONFIG.apiBase}/attendance/me?month=${month}&year=${year}&_t=${Date.now()}`;
  log(`Checking attendance status from API...`);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      Cookie: `token=${token}`,
      Origin: "https://prms.fid-app.my.id",
      Referer: "https://prms.fid-app.my.id/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch attendance status: ${response.status}`);
  }

  const data = await response.json();
  const todayStr = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" }); // Returns "YYYY-MM-DD"
  
  const todayRecord = Array.isArray(data) 
    ? data.find(r => r.date && r.date.startsWith(todayStr)) 
    : null;

  const status = {
    checkedIn: !!(todayRecord && todayRecord.checkInTime),
    checkedOut: !!(todayRecord && todayRecord.checkOutTime)
  };

  log(`Status hari ini (${todayStr}) - CheckedIn: ${status.checkedIn}, CheckedOut: ${status.checkedOut}`);
  return status;
}

/**
 * Perform check-in
 */
async function checkIn(token) {
  const latitude = jitterCoordinate(CONFIG.baseLatitude);
  const longitude = jitterCoordinate(CONFIG.baseLongitude);

  log(`Check-in dengan koordinat: ${latitude}, ${longitude}`);

  const response = await fetch(`${CONFIG.apiBase}/attendance/check-in`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Cookie: `token=${token}`,
      Origin: "https://prms.fid-app.my.id",
      Referer: "https://prms.fid-app.my.id/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({
      photo: null,
      latitude: latitude,
      longitude: longitude,
      note: null,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Check-in failed: ${response.status} - ${JSON.stringify(data)}`
    );
  }

  log(`Check-in berhasil! Response: ${JSON.stringify(data)}`);
  return data;
}

/**
 * Perform check-out
 */
async function checkOut(token) {
  const latitude = jitterCoordinate(CONFIG.baseLatitude);
  const longitude = jitterCoordinate(CONFIG.baseLongitude);
  const note = CONFIG.defaultNote;

  log(`Check-out dengan koordinat: ${latitude}, ${longitude} | Note: "${note}"`);

  const response = await fetch(`${CONFIG.apiBase}/attendance/check-out`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Cookie: `token=${token}`,
      Origin: "https://prms.fid-app.my.id",
      Referer: "https://prms.fid-app.my.id/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({
      photo: null,
      latitude: latitude,
      longitude: longitude,
      note: note,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Check-out failed: ${response.status} - ${JSON.stringify(data)}`
    );
  }

  log(`Check-out berhasil! Response: ${JSON.stringify(data)}`);
  return data;
}

/**
 * Logout from PRMS
 */
async function logout(token) {
  try {
    await fetch(`${CONFIG.apiBase}/auth/logout`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        Cookie: `token=${token}`,
        Origin: "https://prms.fid-app.my.id",
        Referer: "https://prms.fid-app.my.id/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      },
    });
    log("Logout berhasil");
  } catch (err) {
    log(`Logout error (non-critical): ${err.message}`);
  }
}

// ============================================================
// Main Automation Flows
// ============================================================

/**
 * Execute check-in flow with retry
 */
async function executeCheckIn() {
  if (isWeekend()) {
    log(`Hari ini ${getDayName()}, skip check-in (weekend)`);
    return;
  }

  // Random delay: 0-20 menit (dalam ms)
  const delayMinutes = randomInt(0, 20);
  const delayMs = delayMinutes * 60 * 1000 + randomInt(0, 59) * 1000;
  log(`Check-in dijadwalkan, delay ${delayMinutes} menit ${Math.floor((delayMs % 60000) / 1000)} detik...`);

  await sleep(delayMs);

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`Check-in attempt ${attempt}/${maxRetries} - ${getDayName()}, ${getTimestamp()}`);

      const token = await login();
      const status = await getAttendanceStatus(token);

      if (status.checkedIn) {
        log("Sudah check-in hari ini, skip check-in flow.");
        await logout(token);
        return;
      }

      await checkIn(token);
      await logout(token);

      log("Check-in flow selesai!\n");
      return;
    } catch (err) {
      log(`Check-in attempt ${attempt} gagal: ${err.message}`);
      if (attempt < maxRetries) {
        const retryDelay = randomInt(30, 120) * 1000;
        log(`Retry dalam ${Math.floor(retryDelay / 1000)} detik...`);
        await sleep(retryDelay);
      } else {
        log("Semua check-in attempts gagal!\n");
      }
    }
  }
}

/**
 * Execute check-out flow with retry
 */
async function executeCheckOut() {
  if (isWeekend()) {
    log(`Hari ini ${getDayName()}, skip check-out (weekend)`);
    return;
  }

  // Random delay: 0-30 menit (dalam ms)
  const delayMinutes = randomInt(0, 30);
  const delayMs = delayMinutes * 60 * 1000 + randomInt(0, 59) * 1000;
  log(`Check-out dijadwalkan, delay ${delayMinutes} menit ${Math.floor((delayMs % 60000) / 1000)} detik...`);

  await sleep(delayMs);

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`Check-out attempt ${attempt}/${maxRetries} - ${getDayName()}, ${getTimestamp()}`);

      const token = await login();
      const status = await getAttendanceStatus(token);

      if (status.checkedOut) {
        log("Sudah check-out hari ini, skip check-out flow.");
        await logout(token);
        return;
      }

      await checkOut(token);
      await logout(token);

      log("Check-out flow selesai!\n");
      return;
    } catch (err) {
      log(`Check-out attempt ${attempt} gagal: ${err.message}`);
      if (attempt < maxRetries) {
        const retryDelay = randomInt(30, 120) * 1000;
        log(`Retry dalam ${Math.floor(retryDelay / 1000)} detik...`);
        await sleep(retryDelay);
      } else {
        log("Semua check-out attempts gagal!\n");
      }
    }
  }
}

// ============================================================
// Scheduler Setup
// ============================================================

function startScheduler() {
  log("PRMS Auto Attendance started!");
  log(`Email: ${CONFIG.email}`);
  log(`Base Location: ${CONFIG.baseLatitude}, ${CONFIG.baseLongitude}`);
  log(`Default Note: ${CONFIG.defaultNote}`);
  log("---");
  log("Schedule:");
  log("   Check-in:  07:50 WIB + random 0-20 min (jadi 07:50-08:10)");
  log("   Check-out: 17:30 WIB + random 0-30 min (jadi 17:30-18:00)");
  log("   Weekend:   SKIP");
  log("---\n");

  // Check-in: jam 07:50 WIB, Senin-Jumat
  cron.schedule("50 7 * * 1-5", executeCheckIn, {
    timezone: "Asia/Jakarta",
  });

  // Check-out: jam 17:30 WIB, Senin-Jumat
  cron.schedule("30 17 * * 1-5", executeCheckOut, {
    timezone: "Asia/Jakarta",
  });

  log("Cron jobs registered. Waiting for next trigger...\n");
}

// ============================================================
// Validation & Start
// ============================================================

if (!CONFIG.email || !CONFIG.password) {
  console.error("ERROR: EMAIL dan PASSWORD harus diset sebagai environment variable!");
  console.error("   Set via Railway dashboard atau file .env");
  process.exit(1);
}

// Keep the process alive
startScheduler();

// Graceful shutdown
process.on("SIGTERM", () => {
  log("Received SIGTERM, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  log("Received SIGINT, shutting down...");
  process.exit(0);
});
