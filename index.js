try {
  require("dotenv").config();
} catch (e) {
  // dotenv not installed/loaded, ignore
}

const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const { TelegramBot } = require("node-telegram-bot-api");

// Bypass deprecation warning for deleteWebHook in node-telegram-bot-api's internal polling code
if (TelegramBot && TelegramBot.prototype) {
  TelegramBot.prototype.deleteWebHook = TelegramBot.prototype.deleteWebhook;
}

// ============================================================
// Configuration & Settings
// ============================================================
const CONFIG = {
  apiBase: "https://prms-api.fid-app.my.id/api",
  email: process.env.EMAIL,
  password: process.env.PASSWORD,
  baseLatitude: parseFloat(process.env.BASE_LATITUDE || "-6.159868350846804"),
  baseLongitude: parseFloat(process.env.BASE_LONGITUDE || "106.87936991839877"),
  defaultNote: process.env.NOTE || "Standby POC AURORA",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
};

const SETTINGS_FILE = process.env.SETTINGS_PATH || path.join(__dirname, "settings.json");

// Token expiry: 23 jam (safety margin dari 24 jam PRMS)
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

// In-memory token cache
let tokenCache = {
  token: null,
  expiresAt: null, // timestamp ms
};

/**
 * Load settings from file or return default
 */
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, "utf8");
      const parsed = JSON.parse(data);
      // Restore token cache dari file jika ada dan belum expired
      if (parsed._token && parsed._tokenExpiresAt) {
        const expiresAt = new Date(parsed._tokenExpiresAt).getTime();
        if (Date.now() < expiresAt) {
          tokenCache.token = parsed._token;
          tokenCache.expiresAt = expiresAt;
          log(`[Token] Token tersimpan di-load dari file, valid hingga: ${new Date(expiresAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}`);
        } else {
          log(`[Token] Token tersimpan di file sudah expired, akan login ulang saat dibutuhkan.`);
        }
      }
      return parsed;
    }
  } catch (err) {
    console.error(`[Settings] Gagal memuat file pengaturan: ${err.message}`);
  }
  return { customNote: null, skipUntil: null };
}

/**
 * Save settings to file
 */
function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
  } catch (err) {
    console.error(`[Settings] Gagal menyimpan file pengaturan: ${err.message}`);
  }
}

/**
 * Simpan token ke settings.json agar persist jika restart
 */
function saveTokenToFile(token, expiresAt) {
  try {
    const settings = loadSettingsRaw();
    settings._token = token;
    settings._tokenExpiresAt = new Date(expiresAt).toISOString();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
  } catch (err) {
    console.error(`[Token] Gagal menyimpan token ke file: ${err.message}`);
  }
}

/**
 * Load raw settings tanpa side-effect token cache restore
 */
function loadSettingsRaw() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    // ignore
  }
  return { customNote: null, skipUntil: null };
}

/**
 * Dapatkan token yang valid: gunakan cache jika masih valid, login jika tidak.
 * Jika login gagal (misal 502) tapi masih ada cache, pakai cache sebagai fallback.
 */
async function getValidToken() {
  const now = Date.now();

  // Cek cache in-memory
  if (tokenCache.token && tokenCache.expiresAt && now < tokenCache.expiresAt) {
    const sisaJam = ((tokenCache.expiresAt - now) / 3600000).toFixed(1);
    log(`[Token] Menggunakan token cache (sisa ${sisaJam} jam)`);
    return tokenCache.token;
  }

  // Cache kosong / expired — coba login
  log(`[Token] Cache kosong atau expired, melakukan login baru...`);
  try {
    const token = await login();
    const expiresAt = now + TOKEN_TTL_MS;
    tokenCache.token = token;
    tokenCache.expiresAt = expiresAt;
    saveTokenToFile(token, expiresAt);
    log(`[Token] Token baru disimpan, berlaku hingga: ${new Date(expiresAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}`);
    return token;
  } catch (err) {
    log(`[Token] Login gagal: ${err.message}`);
    // Fallback: jika masih ada token lama (meski expired), coba pakai
    if (tokenCache.token) {
      log(`[Token] ⚠️ Fallback ke token lama yang sudah expired karena login gagal (API tidak stabil).`);
      return tokenCache.token;
    }
    throw err;
  }
}

/**
 * Invalidasi token cache (misal saat dapat 401/403 dari API)
 */
function invalidateTokenCache() {
  log(`[Token] Cache token di-invalidasi.`);
  tokenCache.token = null;
  tokenCache.expiresAt = null;
  try {
    const settings = loadSettingsRaw();
    delete settings._token;
    delete settings._tokenExpiresAt;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
  } catch (err) {
    // ignore
  }
}

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
// Holiday & Telegram Integration Functions
// ============================================================

/**
 * Check if today is a public holiday in Indonesia
 */
async function checkIndonesianHoliday() {
  try {
    const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" }); // "YYYY-MM-DD"
    const year = todayStr.split("-")[0];
    const url = `https://api-hari-libur.vercel.app/api?year=${year}`;
    
    log(`Checking holiday status from API for today (${todayStr})...`);
    const response = await fetch(url);
    if (!response.ok) {
      log(`Holiday API returned status: ${response.status}. Skipping holiday check.`);
      return null;
    }
    const res = await response.json();
    if (res && res.status && Array.isArray(res.data)) {
      const holiday = res.data.find(h => h.date === todayStr);
      if (holiday) {
        log(`Today is a national holiday: ${holiday.description}`);
        return holiday.description;
      }
    }
  } catch (err) {
    log(`Error checking holiday API: ${err.message}`);
  }
  return null;
}

let bot = null;

if (CONFIG.telegramToken && CONFIG.telegramChatId) {
  bot = new TelegramBot(CONFIG.telegramToken, { polling: true });
  log("Telegram Bot initialized with long polling.");

  // Register commands for the Telegram Menu button
  bot.setMyCommands([
    { command: "status", description: "Cek status absensi & jadwal" },
    { command: "note", description: "Atur catatan custom checkout" },
    { command: "cuti", description: "Cuti / skip absen untuk hari ini" },
    { command: "cuti_sampai", description: "Atur rentang cuti (YYYY-MM-DD)" },
    { command: "aktifkan", description: "Aktifkan kembali absensi otomatis" },
    { command: "checkin_now", description: "Jalankan check-in manual instan" },
    { command: "checkout_now", description: "Jalankan check-out manual instan" },
    { command: "help", description: "Tampilkan panduan perintah" }
  ]).then(() => {
    log("Telegram menu commands registered successfully.");
  }).catch((err) => {
    log(`Failed to register Telegram menu commands: ${err.message}`);
  });
} else {
  log("Telegram Bot NOT initialized (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing).");
}

async function sendTelegramNotification(message) {
  if (!bot) return;
  try {
    await bot.sendMessage(CONFIG.telegramChatId, message, { parse_mode: "HTML" });
    log("Telegram notification sent successfully.");
  } catch (err) {
    log(`Failed to send Telegram notification: ${err.message}`);
  }
}

if (bot) {
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id.toString();
    const authorizedChatId = CONFIG.telegramChatId.toString();
    
    if (chatId !== authorizedChatId) {
      log(`Unauthorized message received from chat ID: ${chatId}`);
      return;
    }
    
    const text = msg.text ? msg.text.trim() : "";
    if (!text.startsWith("/")) return;
    
    const args = text.split(" ");
    const command = args[0].toLowerCase();
    
    try {
      if (command === "/start" || command === "/help") {
        const helpMessage = `<b>🤖 PRMS Auto Attendance Bot</b>\n\n` +
          `Daftar perintah yang tersedia:\n` +
          `• <code>/status</code> - Cek status bot, koordinat, catatan, & jadwal hari ini\n` +
          `• <code>/note [teks]</code> - Atur catatan custom untuk checkout\n` +
          `• <code>/note reset</code> - Hapus catatan custom dan gunakan default\n` +
          `• <code>/cuti</code> - Lewatkan absen untuk hari ini saja\n` +
          `• <code>/cuti_sampai YYYY-MM-DD</code> - Atur cuti sampai tanggal tertentu\n` +
          `• <code>/aktifkan</code> - Aktifkan kembali absen (hapus status cuti)\n` +
          `• <code>/checkin_now</code> - Jalankan check-in manual instan sekarang\n` +
          `• <code>/checkout_now</code> - Jalankan check-out manual instan sekarang`;
        await bot.sendMessage(chatId, helpMessage, { parse_mode: "HTML" });
      }
      else if (command === "/status") {
        const settings = loadSettings();
        const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
        const holidayDesc = await checkIndonesianHoliday();
        
        let statusCuti = "Aktif (Mengecek Jadwal)";
        if (settings.skipUntil) {
          const skipUntilDate = new Date(settings.skipUntil);
          const todayDate = new Date(todayStr);
          if (todayDate <= skipUntilDate) {
            statusCuti = `Cuti (Skip Absen hingga ${settings.skipUntil})`;
          }
        }
        
        const noteUsed = settings.customNote || CONFIG.defaultNote;

        // Info token cache
        let tokenStatus;
        if (tokenCache.token && tokenCache.expiresAt && Date.now() < tokenCache.expiresAt) {
          const sisaJam = ((tokenCache.expiresAt - Date.now()) / 3600000).toFixed(1);
          const expStr = new Date(tokenCache.expiresAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
          tokenStatus = `✅ Valid (sisa ~${sisaJam} jam, exp: ${expStr})`;
        } else {
          tokenStatus = `❌ Tidak ada / Expired (akan login saat dibutuhkan)`;
        }
        
        const statusMessage = `<b>📊 Status PRMS Auto Attendance</b>\n\n` +
          `• <b>User:</b> <code>${CONFIG.email}</code>\n` +
          `• <b>Lokasi:</b> <code>${CONFIG.baseLatitude}, ${CONFIG.baseLongitude}</code>\n` +
          `• <b>Note Checkout:</b> "${noteUsed}" ${settings.customNote ? "(Custom)" : "(Default)"}\n` +
          `• <b>Status Jadwal:</b> ${statusCuti}\n` +
          `• <b>Token Cache:</b> ${tokenStatus}\n` +
          `• <b>Hari Ini (${getDayName()}, ${todayStr}):</b>\n` +
          `  - Weekend: ${isWeekend() ? "Ya 🛑" : "Tidak ✅"}\n` +
          `  - Hari Libur: ${holidayDesc ? `Ya (${holidayDesc}) 🛑` : "Tidak ✅"}`;
        
        await bot.sendMessage(chatId, statusMessage, { parse_mode: "HTML" });
      }
      else if (command === "/note") {
        if (args.length < 2) {
          const settings = loadSettings();
          const currentNote = settings.customNote || CONFIG.defaultNote;
          await bot.sendMessage(chatId, `Catatan checkout saat ini:\n"${currentNote}" ${settings.customNote ? "(Custom)" : "(Default)"}`, { parse_mode: "HTML" });
          return;
        }
        
        const action = args.slice(1).join(" ");
        const settings = loadSettings();
        
        if (action.toLowerCase() === "reset") {
          settings.customNote = null;
          saveSettings(settings);
          await bot.sendMessage(chatId, `Catatan checkout telah di-reset ke default:\n"${CONFIG.defaultNote}"`, { parse_mode: "HTML" });
        } else {
          settings.customNote = action;
          saveSettings(settings);
          await bot.sendMessage(chatId, `Catatan checkout berhasil diubah ke:\n"${action}"`, { parse_mode: "HTML" });
        }
      }
      else if (command === "/cuti") {
        const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
        const settings = loadSettings();
        settings.skipUntil = todayStr;
        saveSettings(settings);
        await bot.sendMessage(chatId, `Mode cuti diaktifkan. Absensi akan dilewati untuk hari ini (${todayStr}).`, { parse_mode: "HTML" });
      }
      else if (command === "/cuti_sampai") {
        if (args.length < 2) {
          await bot.sendMessage(chatId, "Format salah. Gunakan: <code>/cuti_sampai YYYY-MM-DD</code>", { parse_mode: "HTML" });
          return;
        }
        const targetDate = args[1].trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
          await bot.sendMessage(chatId, "Format tanggal salah. Gunakan format YYYY-MM-DD (contoh: 2026-07-15)", { parse_mode: "HTML" });
          return;
        }
        
        const settings = loadSettings();
        settings.skipUntil = targetDate;
        saveSettings(settings);
        await bot.sendMessage(chatId, `Mode cuti diaktifkan. Absensi akan dilewati hingga tanggal <b>${targetDate}</b>.`, { parse_mode: "HTML" });
      }
      else if (command === "/aktifkan") {
        const settings = loadSettings();
        settings.skipUntil = null;
        saveSettings(settings);
        await bot.sendMessage(chatId, "Mode cuti dinonaktifkan. Jadwal absensi otomatis kembali aktif.", { parse_mode: "HTML" });
      }
      else if (command === "/checkin_now") {
        await bot.sendMessage(chatId, "Menginisiasi check-in manual instan sekarang...", { parse_mode: "HTML" });
        try {
          const token = await getValidToken();
          const status = await getAttendanceStatus(token);
          if (status.checkedIn) {
            await bot.sendMessage(chatId, "Sudah check-in hari ini, aksi dibatalkan.", { parse_mode: "HTML" });
            return;
          }
          const result = await checkIn(token);
          await bot.sendMessage(chatId, `✅ <b>Check-in manual berhasil!</b>\nResponse: <code>${JSON.stringify(result)}</code>`, { parse_mode: "HTML" });
        } catch (err) {
          await bot.sendMessage(chatId, `❌ <b>Check-in manual gagal:</b> ${err.message}`, { parse_mode: "HTML" });
        }
      }
      else if (command === "/checkout_now") {
        await bot.sendMessage(chatId, "Menginisiasi check-out manual instan sekarang...", { parse_mode: "HTML" });
        try {
          const token = await getValidToken();
          const status = await getAttendanceStatus(token);
          if (status.checkedOut) {
            await bot.sendMessage(chatId, "Sudah check-out hari ini, aksi dibatalkan.", { parse_mode: "HTML" });
            return;
          }
          const result = await checkOut(token);
          await bot.sendMessage(chatId, `✅ <b>Check-out manual berhasil!</b>\nResponse: <code>${JSON.stringify(result)}</code>`, { parse_mode: "HTML" });
        } catch (err) {
          await bot.sendMessage(chatId, `❌ <b>Check-out manual gagal:</b> ${err.message}`, { parse_mode: "HTML" });
        }
      }
    } catch (err) {
      log(`Error handling command ${command}: ${err.message}`);
      await bot.sendMessage(chatId, `Terjadi kesalahan saat memproses perintah: ${err.message}`, { parse_mode: "HTML" });
    }
  });
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
  
  const settings = loadSettings();
  const note = settings.customNote || CONFIG.defaultNote;

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
  const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });

  // 1. Weekend Check
  if (isWeekend()) {
    log(`Hari ini ${getDayName()} (${todayStr}), skip check-in (weekend)`);
    return;
  }

  // 2. Holiday API Check
  const holiday = await checkIndonesianHoliday();
  if (holiday) {
    log(`Hari ini hari libur nasional (${holiday}), skip check-in`);
    await sendTelegramNotification(`📢 <b>Check-in Terlewati</b>\nHari ini (${todayStr}) adalah Hari Libur Nasional: <b>${holiday}</b>. Absensi otomatis dilewati.`);
    return;
  }

  // 3. Manual Leave/Skip Check
  const settings = loadSettings();
  if (settings.skipUntil) {
    const skipUntilDate = new Date(settings.skipUntil);
    const todayDate = new Date(todayStr);
    if (todayDate <= skipUntilDate) {
      log(`Hari ini (${todayStr}) diset skip/cuti sampai ${settings.skipUntil}, skip check-in`);
      await sendTelegramNotification(`📢 <b>Check-in Terlewati</b>\nHari ini (${todayStr}) dalam masa cuti/skip manual (sampai ${settings.skipUntil}). Absensi otomatis dilewati.`);
      return;
    }
  }

  // Random delay: 0-20 menit (dalam ms)
  const delayMinutes = randomInt(0, 20);
  const delayMs = delayMinutes * 60 * 1000 + randomInt(0, 59) * 1000;
  const msg = `🕒 <b>Check-in Terjadwal</b>\nJadwal check-in hari ini dimulai dengan delay ${delayMinutes} menit ${Math.floor((delayMs % 60000) / 1000)} detik...`;
  log(msg.replace(/<[^>]*>/g, ""));
  await sendTelegramNotification(msg);

  await sleep(delayMs);

  // Deadline: 09:00 WIB — di atas itu tidak masuk akal checkin lagi
  const deadlineHour = 9;
  const now = new Date();
  const deadline = new Date(now.toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" }));
  deadline.setUTCHours(deadlineHour - 7); // convert WIB to UTC (WIB = UTC+7)
  const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 menit
  const WARN_EVERY = 3; // kirim notif Telegram setiap N kali gagal berurutan

  let attempt = 0;
  let lastError = null;

  while (Date.now() < deadline.getTime()) {
    attempt++;
    const sisaMs = deadline.getTime() - Date.now();
    const sisaMenit = Math.floor(sisaMs / 60000);
    try {
      log(`Check-in attempt #${attempt} - ${getDayName()}, ${getTimestamp()} (deadline dalam ${sisaMenit} menit)`);

      const token = await getValidToken();
      const status = await getAttendanceStatus(token);

      if (status.checkedIn) {
        log("Sudah check-in hari ini, skip check-in flow.");
        return;
      }

      const result = await checkIn(token);

      log("Check-in flow selesai!\n");
      await sendTelegramNotification(`✅ <b>Check-in Berhasil!</b>\n• Jam: <code>${getTimestamp()}</code>${attempt > 1 ? `\n• Berhasil setelah ${attempt} percobaan` : ""}\n• Koordinat: <code>${result.checkInLat || "-"}, ${result.checkInLng || "-"}</code>`);
      return;
    } catch (err) {
      lastError = err;
      log(`Check-in attempt #${attempt} gagal: ${err.message}`);

      // Jika 401/403 (bukan masalah API tidak stabil), invalidasi cache dan STOP retry
      if (err.message.includes("401") || err.message.includes("403") || err.message.includes("Unauthorized")) {
        invalidateTokenCache();
        log("Check-in dihentikan karena error autentikasi (401/403).");
        await sendTelegramNotification(`❌ <b>Check-in Gagal — Error Autentikasi</b>\nError 401/403 diterima, retry dihentikan.\nError: <code>${err.message}</code>`);
        return;
      }

      // Kirim notif peringatan setiap WARN_EVERY kali gagal (tidak spam setiap attempt)
      if (attempt % WARN_EVERY === 0) {
        await sendTelegramNotification(`⚠️ <b>Check-in Belum Berhasil</b>\nSudah ${attempt}x percobaan, API masih tidak stabil.\nAkan terus retry hingga 09:00 WIB (sisa ~${sisaMenit} menit).\nError terakhir: <code>${err.message}</code>`);
      }

      // Tunggu sebelum retry berikutnya (jika masih ada waktu)
      const nextRetryMs = Math.min(RETRY_INTERVAL_MS, deadline.getTime() - Date.now());
      if (nextRetryMs > 5000) {
        log(`Retry dalam ${Math.floor(nextRetryMs / 1000)} detik...`);
        await sleep(nextRetryMs);
      }
    }
  }

  // Keluar dari loop karena deadline tercapai
  log("Check-in gagal sampai deadline 09:00 WIB.\n");
  await sendTelegramNotification(`❌ <b>Check-in Gagal!</b>\nSudah ${attempt}x percobaan hingga deadline 09:00 WIB, semua gagal.\nError terakhir: <code>${lastError?.message || "unknown"}</code>\nGunakan /checkin_now jika ingin coba manual.`);
}

/**
 * Execute check-out flow with retry
 */
async function executeCheckOut() {
  const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });

  // 1. Weekend Check
  if (isWeekend()) {
    log(`Hari ini ${getDayName()} (${todayStr}), skip check-out (weekend)`);
    return;
  }

  // 2. Holiday API Check
  const holiday = await checkIndonesianHoliday();
  if (holiday) {
    log(`Hari ini hari libur nasional (${holiday}), skip check-out`);
    await sendTelegramNotification(`📢 <b>Check-out Terlewati</b>\nHari ini (${todayStr}) adalah Hari Libur Nasional: <b>${holiday}</b>. Absensi otomatis dilewati.`);
    return;
  }

  // 3. Manual Leave/Skip Check
  const settings = loadSettings();
  if (settings.skipUntil) {
    const skipUntilDate = new Date(settings.skipUntil);
    const todayDate = new Date(todayStr);
    if (todayDate <= skipUntilDate) {
      log(`Hari ini (${todayStr}) diset skip/cuti sampai ${settings.skipUntil}, skip check-out`);
      await sendTelegramNotification(`📢 <b>Check-out Terlewati</b>\nHari ini (${todayStr}) dalam masa cuti/skip manual (sampai ${settings.skipUntil}). Absensi otomatis dilewati.`);
      return;
    }
  }

  // Random delay: 0-30 menit (dalam ms)
  const delayMinutes = randomInt(0, 30);
  const delayMs = delayMinutes * 60 * 1000 + randomInt(0, 59) * 1000;
  const msg = `🕒 <b>Check-out Terjadwal</b>\nJadwal check-out hari ini dimulai dengan delay ${delayMinutes} menit ${Math.floor((delayMs % 60000) / 1000)} detik...`;
  log(msg.replace(/<[^>]*>/g, ""));
  await sendTelegramNotification(msg);

  await sleep(delayMs);

  // Deadline: 19:00 WIB — di atas itu tidak wajar checkout
  const deadlineHour = 19;
  const now = new Date();
  const deadline = new Date(now.toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" }));
  deadline.setUTCHours(deadlineHour - 7); // convert WIB to UTC (WIB = UTC+7)
  const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 menit
  const WARN_EVERY = 3; // kirim notif Telegram setiap N kali gagal berurutan

  let attempt = 0;
  let lastError = null;

  while (Date.now() < deadline.getTime()) {
    attempt++;
    const sisaMs = deadline.getTime() - Date.now();
    const sisaMenit = Math.floor(sisaMs / 60000);
    try {
      log(`Check-out attempt #${attempt} - ${getDayName()}, ${getTimestamp()} (deadline dalam ${sisaMenit} menit)`);

      const token = await getValidToken();
      const status = await getAttendanceStatus(token);

      if (status.checkedOut) {
        log("Sudah check-out hari ini, skip check-out flow.");
        return;
      }

      const result = await checkOut(token);

      log("Check-out flow selesai!\n");
      await sendTelegramNotification(`✅ <b>Check-out Berhasil!</b>\n• Jam: <code>${getTimestamp()}</code>${attempt > 1 ? `\n• Berhasil setelah ${attempt} percobaan` : ""}\n• Note: "${result.checkOutNote || "-"}"\n• Koordinat: <code>${result.checkOutLat || "-"}, ${result.checkOutLng || "-"}</code>`);
      return;
    } catch (err) {
      lastError = err;
      log(`Check-out attempt #${attempt} gagal: ${err.message}`);

      // Jika 401/403 (bukan masalah API tidak stabil), invalidasi cache dan STOP retry
      if (err.message.includes("401") || err.message.includes("403") || err.message.includes("Unauthorized")) {
        invalidateTokenCache();
        log("Check-out dihentikan karena error autentikasi (401/403).");
        await sendTelegramNotification(`❌ <b>Check-out Gagal — Error Autentikasi</b>\nError 401/403 diterima, retry dihentikan.\nError: <code>${err.message}</code>`);
        return;
      }

      // Kirim notif peringatan setiap WARN_EVERY kali gagal (tidak spam setiap attempt)
      if (attempt % WARN_EVERY === 0) {
        await sendTelegramNotification(`⚠️ <b>Check-out Belum Berhasil</b>\nSudah ${attempt}x percobaan, API masih tidak stabil.\nAkan terus retry hingga 19:00 WIB (sisa ~${sisaMenit} menit).\nError terakhir: <code>${err.message}</code>`);
      }

      // Tunggu sebelum retry berikutnya (jika masih ada waktu)
      const nextRetryMs = Math.min(RETRY_INTERVAL_MS, deadline.getTime() - Date.now());
      if (nextRetryMs > 5000) {
        log(`Retry dalam ${Math.floor(nextRetryMs / 1000)} detik...`);
        await sleep(nextRetryMs);
      }
    }
  }

  // Keluar dari loop karena deadline tercapai
  log("Check-out gagal sampai deadline 19:00 WIB.\n");
  await sendTelegramNotification(`❌ <b>Check-out Gagal!</b>\nSudah ${attempt}x percobaan hingga deadline 19:00 WIB, semua gagal.\nError terakhir: <code>${lastError?.message || "unknown"}</code>\nGunakan /checkout_now jika ingin coba manual.`);
}

// ============================================================
// Scheduler Setup
// ============================================================

/**
 * Pre-login pagi: simpan token sebelum jadwal check-in
 * Dijalankan jam 07:00 WIB agar token sudah siap saat check-in jam 07:50+
 */
async function executePreLogin() {
  if (isWeekend()) return;

  log("[Pre-Login] Melakukan pre-login pagi hari untuk menyimpan token...");
  try {
    // Invalidasi cache dulu agar dapat token segar
    tokenCache.token = null;
    tokenCache.expiresAt = null;

    const token = await login();
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    tokenCache.token = token;
    tokenCache.expiresAt = expiresAt;
    saveTokenToFile(token, expiresAt);

    const expStr = new Date(expiresAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    log(`[Pre-Login] ✅ Token pagi berhasil disimpan, berlaku hingga: ${expStr}`);
    await sendTelegramNotification(`🔑 <b>Pre-Login Berhasil</b>\nToken tersimpan dan siap digunakan untuk check-in & check-out hari ini.\n• Berlaku hingga: <code>${expStr}</code>`);
  } catch (err) {
    log(`[Pre-Login] ❌ Gagal: ${err.message}`);
    await sendTelegramNotification(`⚠️ <b>Pre-Login Gagal</b>\nGagal menyimpan token pagi ini: <code>${err.message}</code>\nBot akan mencoba login ulang saat check-in/checkout.`);
  }
}

function startScheduler() {
  log("PRMS Auto Attendance started!");
  log(`Email: ${CONFIG.email}`);
  log(`Base Location: ${CONFIG.baseLatitude}, ${CONFIG.baseLongitude}`);
  log(`Default Note: ${CONFIG.defaultNote}`);
  log("---");
  log("Schedule:");
  log("   Pre-Login: 07:00 WIB (simpan token untuk hari ini)");
  log("   Check-in:  07:50 WIB + random 0-20 min (jadi 07:50-08:10)");
  log("   Check-out: 17:30 WIB + random 0-30 min (jadi 17:30-18:00)");
  log("   Weekend:   SKIP");
  log("---\n");

  // Pre-login: jam 07:00 WIB, Senin-Jumat
  cron.schedule("0 7 * * 1-5", executePreLogin, {
    timezone: "Asia/Jakarta",
  });

  // Check-in: jam 07:50 WIB, Senin-Jumat
  cron.schedule("50 7 * * 1-5", executeCheckIn, {
    timezone: "Asia/Jakarta",
  });

  // Check-out: jam 17:30 WIB, Senin-Jumat
  cron.schedule("30 17 * * 1-5", executeCheckOut, {
    timezone: "Asia/Jakarta",
  });

  log("Cron jobs registered. Waiting for next trigger...\n");

  sendTelegramNotification(`🚀 <b>PRMS Auto Attendance Teraktifkan!</b>\n` +
    `• User: <code>${CONFIG.email}</code>\n` +
    `• Jadwal: Senin-Jumat\n` +
    `• Pre-Login: 07:00 WIB (token disimpan)\n` +
    `• Check-in: 07:50 WIB (delay 0-20m)\n` +
    `• Check-out: 17:30 WIB (delay 0-30m)`);
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
